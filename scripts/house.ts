// House players: NPC accounts with their own wallets that give a visitor someone to play against.
//
// A minority game needs a crowd. With nobody else in a round, one side has no votes and the round is void.
// So the house joins any round a person has sealed a vote in, and plays a showcase round on a schedule so the
// board always has a recent result. House players use the same public methods as everyone (commit, reveal,
// claim), pay the same stake and bond, and get no information a visitor doesn't have.
//
// The first eight are "the regulars" (web/src/lib/regulars.ts): each has a public habit that reads only
// finished rounds, and keeps to it about four rounds in five. Four of them sit in each round (five in a
// showcase round), chosen by a public hash of the round number. GET /regulars reports the table, every
// regular's lean and record; `npm run judge` recomputes all of it from the chain.
//
//   npm run house                 run forever (a small always-on process)
//   npm run house -- --now        also play the round that is open right now, then keep running
//   npm run house -- status       the house players' balances
//   npm run house -- fund 0.6     top each house player up to this many NEAR in the game (from FUNDER, else the owner)
//
// With GUEST_FUNDER (or PORT) set, the same process also serves the guest-account API (scripts/guest.ts).
//
// Keys: HOUSE_KEYS (a JSON list of { accountId, secretKey }) or .keys/seed.json. Salts are derived from
// HOUSE_SECRET and the round, so a restart between sealing and opening doesn't lose a vote.
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nearToYocto } from "near-api-js";
import { accountFromKey, contractId, fmt, parentAccount, provider, view } from "./lib";
import { guestFunder, startGuestServer } from "./guest";
import { FOLLOW, REGULARS, TABLE_SIZE, contextFor, lean, other, reason, type PastRound, type Regular, type Result } from "../web/src/lib/regulars";

type Choice = "A" | "B";
type Bot = { accountId: string; secretKey: string };
type Cfg = { genesis_ts: string; round_duration_ns: string; stake: string; bond: string; fee_bps: number };
type Player = { balance: string; streak: number; pending: number[] };
type Entry = { committed: boolean; revealed: Choice | null };
type Question = { text: string; a: string; b: string };
type RoundView = { id: number; question: Question; commits: number; revealed_a: number; revealed_b: number; outcome: Result | null };
/** A finished round the regulars can read: the result, and what each regular who played it picked. */
type Hist = PastRound & { question: Question; a: number; b: number; commits: number; sat: string[] };

const TGAS = 1_000_000_000_000n;
const WALLET_MIN = 300_000_000_000_000_000_000_000n; // 0.3 NEAR kept in each house wallet for gas
const POLL_MS = Number(process.env.HOUSE_POLL_MS || 12_000);
/** A showcase round every this many rounds (40 three-minute rounds = every 2 hours). 0 turns it off. */
const SHOWCASE_EVERY = Number(process.env.HOUSE_SHOWCASE_EVERY ?? 40);
/** Don't start sealing with less than this left in the round: a late vote would be rejected (WRONG_PHASE). */
const MIN_LEFT_MS = 25_000;

const allBots: Bot[] = process.env.HOUSE_KEYS ? JSON.parse(process.env.HOUSE_KEYS) : existsSync(".keys/seed.json") ? JSON.parse(readFileSync(".keys/seed.json", "utf8")) : [];
/** HOUSE_COUNT limits the house to the first N accounts (fewer accounts to keep funded). */
const bots = allBots.slice(0, Number(process.env.HOUSE_COUNT || allBots.length));
if (!bots.length) throw new Error("No house players: set HOUSE_KEYS or run `npm run seed -- setup` first.");
const SECRET = process.env.HOUSE_SECRET || createHash("sha256").update(bots.map((b) => b.secretKey).join("|")).digest("hex");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const short = (id: string) => id.split(".")[0];
const saltOf = (round: number, id: string) => createHmac("sha256", SECRET).update(`salt:${round}:${id}`).digest("hex");
const hashOf = (round: number, id: string, choice: Choice, salt: string) => createHash("sha256").update(`${round}:${id}:${choice}:${salt}`, "utf8").digest("hex");
/** A number in [0, 1) fixed by the secret and the label: the house's coin, the same after a restart. */
const coin = (label: string) => parseInt(createHmac("sha256", SECRET).update(label).digest("hex").slice(0, 12), 16) / 2 ** 48;

async function call<T = unknown>(b: Bot, methodName: string, args: Record<string, unknown>, deposit = 0n): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return (await accountFromKey(b.accountId, b.secretKey).callFunction({ contractId: contractId(), methodName, args, gas: (methodName === "claim" ? 60n : 30n) * TGAS, deposit })) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ALREADY_COMMITTED|ALREADY_REVEALED/.test(msg)) return null; // an earlier try landed
      if (/WRONG_PHASE|BAD_REVEAL|LOW_BALANCE|NOT_REGISTERED|TOO_MANY_PENDING/.test(msg)) throw new Error(msg.match(/[A-Z_]{6,}/)?.[0] ?? msg);
      if (attempt === 3) throw e;
      await sleep(4_000 * (attempt + 1)); // a rate-limited RPC: wait and retry
    }
  }
  return null;
}

let lastSeen = -1; // for /health
let lastSealed: { round: number; votes: number; why: string } | null = null;

let cfg: Cfg;
let offsetMs = 0;
let offsetAt = 0;
async function clock() {
  if (!cfg) cfg = await view<Cfg>("get_config");
  if (Date.now() - offsetAt > 60_000) {
    const block = await provider().viewBlock({ finality: "final" });
    offsetMs = Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) - Date.now();
    offsetAt = Date.now();
  }
  const dur = Number(BigInt(cfg.round_duration_ns) / 1_000_000n);
  const since = Date.now() + offsetMs - Number(BigInt(cfg.genesis_ts) / 1_000_000n);
  return { round: Math.floor(since / dur), msLeft: dur - (since % dur) };
}
const cost = () => BigInt(cfg.stake) + BigInt(cfg.bond);

// ---------- the regulars ----------

/** Regulars this process holds a key for. */
const regs: Regular[] = REGULARS.filter((r) => bots[r.index]);
const botOf = (r: Regular) => bots[r.index];
/** Habits count from this round: earlier rounds were played before the regulars had habits. */
const SINCE = Number(process.env.HOUSE_HABITS_SINCE || 0);
const isShowcase = (round: number) => SHOWCASE_EVERY > 0 && round % SHOWCASE_EVERY === 0;

const hist = new Map<number, Hist>(); // finished rounds, by id
const money = new Map<string, Player | null>(); // regular id -> game account, read at the start of each round
let table: { round: number; ids: string[]; question: Question } | null = null;
let opening: { id: number; picks: Record<string, Choice | null> } | null = null;

/** Who sits in `round`: a public shuffle of the regulars who can afford it, four of them (five in a showcase round). */
function seatsFor(round: number, eligible: string[]) {
  const key = (id: string) => createHash("sha256").update(`table:${round}:${id}`).digest("hex");
  return [...eligible].sort((x, y) => (key(x) < key(y) ? -1 : 1)).slice(0, TABLE_SIZE + (isShowcase(round) ? 1 : 0));
}

/** What each regular did in a round, read from the chain. */
async function picksIn(round: number) {
  const entries = await Promise.all(regs.map((r) => view<Entry>("get_entry", { account_id: botOf(r).accountId, round_id: round })));
  const picks: Record<string, Choice | null> = {};
  const sat: string[] = [];
  regs.forEach((r, i) => {
    if (!entries[i].committed) return;
    sat.push(r.id);
    picks[r.id] = entries[i].revealed;
  });
  return { picks, sat };
}

// The contract deletes a vote's entry when its round is claimed, so a pick can only be read from the chain
// while its round is being opened. The house notes each regular's opened pick then (`seen`), and files it
// under the round once the round is final (`hist`). Both are kept in HOUSE_STATE so a restart keeps the records.
const STATE_FILE = process.env.HOUSE_STATE || ".house-state.json";
const seen = new Map<number, { picks: Record<string, Choice | null>; sat: string[] }>();
type State = { contract: string; hist: Hist[]; seen: Array<[number, { picks: Record<string, Choice | null>; sat: string[] }]> };
/** What GET /state serves: the records, so a new deployment can pick them up from the one it replaces. */
export const stateInfo = (): State => ({ contract: contractId(), hist: [...hist.values()], seen: [...seen.entries()] });
function takeState(j: State, from: string) {
  if (j.contract !== contractId() || !Array.isArray(j.hist)) return;
  for (const h of j.hist) if (!hist.has(h.id)) hist.set(h.id, h);
  for (const [id, v] of j.seen ?? []) if (!seen.has(id)) seen.set(id, v);
  log(`house: ${hist.size} finished rounds remembered (from ${from})`);
}
/** Records come from the state file, and from the deployment this one is replacing (still up while this one starts). */
async function loadState() {
  try {
    takeState(JSON.parse(readFileSync(STATE_FILE, "utf8")), STATE_FILE);
  } catch {
    /* no file yet */
  }
  const prev = process.env.HOUSE_PREVIOUS_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  if (!prev) return;
  try {
    const res = await fetch(`${prev}/state`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) takeState((await res.json()) as State, prev);
  } catch {
    /* nothing running there yet */
  }
}
function saveState() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(stateInfo()));
  } catch (e) {
    log("couldn't save state:", e instanceof Error ? e.message : e);
  }
}

/** Notes what the regulars opened in `round` (call while it is being opened, after the house has opened its votes). */
async function note(round: number) {
  const got = await picksIn(round);
  if (got.sat.length) seen.set(round, got);
  opening = { id: round, picks: got.picks };
  for (const id of [...seen.keys()]) if (id < round - 30) seen.delete(id);
}

/** Files finished rounds the regulars played (the contract returns the latest 20 rounds that had votes). */
async function loadHistory() {
  const recent = await view<RoundView[]>("get_recent_rounds", { limit: 20 });
  for (const r of recent) {
    if (hist.has(r.id) || !r.outcome) continue;
    const got = seen.get(r.id) ?? (await picksIn(r.id)); // unclaimed entries can still be read
    if (!got.sat.length) continue;
    hist.set(r.id, { id: r.id, result: r.outcome, picks: got.picks, sat: got.sat, question: r.question, a: r.revealed_a, b: r.revealed_b, commits: r.commits });
    seen.delete(r.id);
  }
  for (const id of [...hist.keys()].sort((x, y) => y - x).slice(80)) hist.delete(id);
  saveState();
}

async function loadMoney() {
  const players = await Promise.all(regs.map((r) => view<Player | null>("get_player", { account_id: botOf(r).accountId })));
  regs.forEach((r, i) => money.set(r.id, players[i]));
}

const canPlay = (id: string) => {
  const p = money.get(id);
  return !!p && BigInt(p.balance) >= cost() && p.pending.length < 8;
};

/** Sets the table for `round`. After a restart mid-round the regulars already in the round are the table. */
async function setTable(round: number, question: Question) {
  const { sat } = await picksIn(round);
  table = { round, question, ids: sat.length ? sat : seatsFor(round, regs.filter((r) => canPlay(r.id)).map((r) => r.id)) };
}

const leanOf = (id: string, round: number, question: Question, seats: string[]) => lean(id, contextFor(id, round, question, [...hist.values()], seats));

/** Seals the table's votes for `round`. Each regular takes their lean, or the other side when the keyed coin says so. */
async function seal(round: number, why: string) {
  if (!table || table.round !== round) return;
  const seats = table.ids;
  if (seats.length < 3) return log(`round ${round}: only ${seats.length} regulars can afford a round. Run: npm run house -- fund 0.6`);
  let done = 0;
  const said: string[] = [];
  await Promise.all(
    seats.map(async (id) => {
      const b = botOf(regs.find((r) => r.id === id)!);
      const l = leanOf(id, round, table!.question, seats);
      const choice: Choice = l === null ? (coin(`flip:${round}:${id}`) < 0.5 ? "A" : "B") : coin(`keep:${round}:${id}`) < FOLLOW ? l : other(l);
      try {
        await call(b, "commit", { round_id: round, hash: hashOf(round, b.accountId, choice, saltOf(round, b.accountId)) });
        done++;
        said.push(id);
      } catch (e) {
        log(`  ${id} couldn't seal: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  log(`round ${round}: ${done} regulars sealed (${why}): ${said.join(", ")}`);
  if (done) lastSealed = { round, votes: done, why };
}

/** What GET /regulars reports: the table, every lean with its reason, and each regular's record. */
export function regularsInfo() {
  const stake = cfg ? BigInt(cfg.stake) : 0n;
  const bond = cfg ? BigInt(cfg.bond) : 0n;
  const win = stake - (stake * BigInt(cfg?.fee_bps ?? 0)) / 10_000n;
  const rounds = [...hist.values()].sort((x, y) => y.id - x.id);
  const leansIn = (h: Hist) => Object.fromEntries(h.sat.map((id) => [id, h.id >= SINCE ? leanOf(id, h.id, h.question, h.sat) : null]));
  const pastLeans = new Map(rounds.map((h) => [h.id, leansIn(h)]));
  const seat = (id: string) => {
    const c = contextFor(id, table!.round, table!.question, rounds, table!.ids);
    return { id, lean: lean(id, c), why: reason(id, c) };
  };
  return {
    contract: contractId(),
    round: table?.round ?? null,
    follow: FOLLOW,
    since: SINCE,
    showcaseEvery: SHOWCASE_EVERY,
    table: table ? table.ids.map(seat) : [],
    opening,
    regulars: regs.map((r) => {
      const mine = rounds.filter((h) => h.sat.includes(r.id));
      let won = 0, lost = 0, voided = 0, unopened = 0, kept = 0, keptOf = 0, net = 0n;
      for (const h of mine) {
        const pick = h.picks[r.id];
        if (!pick) { unopened++; net -= stake + bond; }
        else if (h.result === "Void") voided++;
        else if (h.result === pick) { won++; net += win; }
        else { lost++; net -= stake; }
        const l = pastLeans.get(h.id)![r.id];
        if (pick && l) { keptOf++; if (pick === l) kept++; }
      }
      const p = money.get(r.id);
      return {
        id: r.id, name: r.name, habit: r.habit, rule: r.rule, account: botOf(r).accountId,
        balance: p?.balance ?? "0", out: !canPlay(r.id) && !table?.ids.includes(r.id), streak: p?.streak ?? 0,
        played: mine.length, won, lost, void: voided, unopened, kept, keptOf, net: net.toString(),
        last: mine.slice(0, 8).map((h) => ({ round: h.id, pick: h.picks[r.id], lean: pastLeans.get(h.id)![r.id], result: h.result })),
      };
    }),
    rounds: rounds.slice(0, 20).map((h) => ({ id: h.id, result: h.result, a: h.a, b: h.b, commits: h.commits, question: h.question, picks: h.picks, leans: pastLeans.get(h.id) })),
  };
}

/** Opens the house's votes from `round`. The side isn't stored anywhere: the salt is derived, and the side is
 *  whichever of the two matches the sealed hash, so this also works after a restart. */
async function open(round: number) {
  let opened = 0;
  for (const b of bots) {
    const e = await view<Entry>("get_entry", { account_id: b.accountId, round_id: round });
    if (!e.committed || e.revealed) continue;
    for (const choice of ["A", "B"] as Choice[]) {
      try {
        await call(b, "reveal", { round_id: round, choice, salt_hex: saltOf(round, b.accountId) });
        opened++;
        break;
      } catch (err) {
        if (!(err instanceof Error && err.message === "BAD_REVEAL")) {
          log(`  ${short(b.accountId)} couldn't open round ${round}: ${err instanceof Error ? err.message : err}`);
          break;
        }
      }
    }
  }
  if (opened) log(`round ${round}: ${opened} house votes opened`);
  return opened;
}

async function collect(round: number) {
  for (const b of bots) {
    const p = await view<Player | null>("get_player", { account_id: b.accountId });
    if (p?.pending.some((r) => r + 2 <= round)) await call(b, "claim", {}).catch((e) => log(`  ${short(b.accountId)} couldn't claim: ${e instanceof Error ? e.message : e}`));
  }
}

async function houseVotesIn(round: number) {
  let n = 0;
  for (const b of bots) if ((await view<Entry>("get_entry", { account_id: b.accountId, round_id: round })).committed) n++;
  return n;
}

async function status() {
  await clock();
  let total = 0n;
  for (const b of bots) {
    const p = await view<Player | null>("get_player", { account_id: b.accountId });
    const wallet = BigInt((await provider().viewAccount({ accountId: b.accountId })).amount);
    total += BigInt(p?.balance ?? 0);
    console.log(`  ${short(b.accountId).padEnd(8)} game ${fmt(p?.balance ?? 0).padEnd(7)} wallet ${fmt(wallet).slice(0, 6)} streak ${p?.streak ?? 0} pending [${p?.pending.join(",") ?? ""}]`);
  }
  console.log(`house total in the game: ${fmt(total)} NEAR · a played round costs the house about ${fmt((cost() / 2n) * 2n)} NEAR (it goes to the streak pot and fees)`);
}

/** Tops each house player's game balance up to `target` NEAR, paid by FUNDER (a key file) or the owner account. */
async function fund(target: string) {
  await clock();
  const payer = process.env.FUNDER ? (() => { const k = JSON.parse(readFileSync(process.env.FUNDER!, "utf8")); return accountFromKey(k.accountId, k.secretKey); })() : parentAccount();
  const want = nearToYocto(target);
  for (const b of bots) {
    // Gas is prepaid from the wallet (a claim holds about 0.06 NEAR), so a thin wallet stalls the player.
    const wallet = BigInt((await provider().viewAccount({ accountId: b.accountId })).amount);
    if (wallet < WALLET_MIN) {
      await payer.transfer({ receiverId: b.accountId, amount: WALLET_MIN - wallet });
      console.log(`✅ ${short(b.accountId)}: wallet topped up to ${fmt(WALLET_MIN)} NEAR for gas`);
    }
    const p = await view<Player | null>("get_player", { account_id: b.accountId });
    const have = BigInt(p?.balance ?? 0);
    if (have >= want) continue;
    const need = want - have;
    await payer.transfer({ receiverId: b.accountId, amount: need + nearToYocto("0.02") }); // a little extra for gas
    await call(b, "deposit", {}, need < cost() ? cost() : need);
    console.log(`✅ ${short(b.accountId)}: +${fmt(need < cost() ? cost() : need)} NEAR (from ${payer.accountId})`);
  }
}

async function run() {
  await loadState();
  log(`house: ${regs.length} regulars (${bots.length} accounts) on ${contractId()}, showcase every ${SHOWCASE_EVERY || "never"} rounds, habits since round ${SINCE}`);
  let force = process.argv.includes("--now");
  let last = -1;
  const sealedIn = new Map<number, number>(); // round -> house votes sealed
  for (;;) {
    try {
      const { round, msLeft } = await clock();
      lastSeen = round;
      if (round !== last) {
        // A new round: open what the house sealed last round, collect finished rounds, and learn where we are
        // (after a restart the house may already have votes in this round).
        last = round;
        if (round > 0) {
          await open(round - 1);
          await note(round - 1);
        }
        await loadHistory(); // before collecting: claiming a round deletes its entries
        await collect(round);
        await loadMoney();
        const now = await view<{ id: number; question: Question }>("get_current_round");
        if (now.id === round) await setTable(round, now.question);
        sealedIn.set(round, await houseVotesIn(round));
        for (const r of sealedIn.keys()) if (r < round - 3) sealedIn.delete(r);
      }
      if ((sealedIn.get(round) ?? 0) === 0 && msLeft > MIN_LEFT_MS) {
        const cur = await view<{ id: number; commits: number }>("get_current_round");
        const showcase = isShowcase(round);
        if (cur.id === round && (cur.commits > 0 || showcase || force)) {
          await seal(round, cur.commits > 0 ? `${cur.commits} visitor vote${cur.commits === 1 ? "" : "s"} in` : force ? "asked for" : "showcase round");
          sealedIn.set(round, await houseVotesIn(round));
          force = false;
        }
      }
    } catch (e) {
      log("retrying after:", e instanceof Error ? e.message.slice(0, 160) : e);
    }
    await sleep(POLL_MS);
  }
}

/** What /health reports about the house. */
export const houseInfo = () => ({ players: bots.length, showcaseEvery: SHOWCASE_EVERY, lastRoundSeen: lastSeen, lastSealed });

const cmd = process.argv[2];
if (cmd !== "status" && cmd !== "fund" && (process.env.PORT || guestFunder())) startGuestServer(houseInfo, regularsInfo, stateInfo);
(cmd === "status" ? status() : cmd === "fund" ? fund(process.argv[3] || "0.6") : run()).catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
