// House players: NPC accounts with their own wallets that give a visitor someone to play against.
//
// A minority game needs a crowd. With nobody else in a round, one side has no votes and the round is void.
// So the house joins any round a person has sealed a vote in, and plays a showcase round on a schedule so the
// board always has a recent result. House players use the same public methods as everyone (commit, reveal,
// claim), pay the same stake and bond, and get no information a visitor doesn't have: they pick their sides
// from a random number, not from anyone's vote (which nobody can see anyway).
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
import { existsSync, readFileSync } from "node:fs";
import { nearToYocto } from "near-api-js";
import { accountFromKey, contractId, fmt, parentAccount, provider, view } from "./lib";
import { guestFunder, startGuestServer } from "./guest";

type Choice = "A" | "B";
type Bot = { accountId: string; secretKey: string };
type Cfg = { genesis_ts: string; round_duration_ns: string; stake: string; bond: string };
type Player = { balance: string; streak: number; pending: number[] };
type Entry = { committed: boolean; revealed: Choice | null };

const TGAS = 1_000_000_000_000n;
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

/** Seals the house's votes for `round`: four or six players, split 1 to 3 or 2 to 4, the smaller side by coin. */
async function seal(round: number, why: string) {
  const funded: Bot[] = [];
  for (const b of bots) {
    const p = await view<Player | null>("get_player", { account_id: b.accountId });
    if (p && BigInt(p.balance) >= cost() && p.pending.length < 8) funded.push(b);
    if (funded.length === 6) break;
  }
  if (funded.length < 4) return log(`round ${round}: only ${funded.length} house players can afford a round. Run: npm run house -- fund 0.6`);
  // A split that differs by two or more, so one more vote on either side still leaves a winner.
  const six = funded.length >= 6 && coin(`size:${round}`) < 0.5;
  const team = funded.slice(0, six ? 6 : 4);
  const small = six ? 2 : 1;
  const minority: Choice = coin(`side:${round}`) < 0.5 ? "A" : "B";
  const order = [...team].sort((x, y) => coin(`order:${round}:${x.accountId}`) - coin(`order:${round}:${y.accountId}`));
  let done = 0;
  await Promise.all(
    order.map(async (b, i) => {
      const choice: Choice = i < small ? minority : minority === "A" ? "B" : "A";
      try {
        await call(b, "commit", { round_id: round, hash: hashOf(round, b.accountId, choice, saltOf(round, b.accountId)) });
        done++;
      } catch (e) {
        log(`  ${short(b.accountId)} couldn't seal: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  log(`round ${round}: ${done} house votes sealed (${why})`);
  if (done) lastSealed = { round, votes: done, why };
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
  log(`house: ${bots.length} players on ${contractId()}, showcase every ${SHOWCASE_EVERY || "never"} rounds`);
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
        if (round > 0) await open(round - 1);
        await collect(round);
        sealedIn.set(round, await houseVotesIn(round));
        for (const r of sealedIn.keys()) if (r < round - 3) sealedIn.delete(r);
      }
      if ((sealedIn.get(round) ?? 0) === 0 && msLeft > MIN_LEFT_MS) {
        const cur = await view<{ id: number; commits: number }>("get_current_round");
        const showcase = SHOWCASE_EVERY > 0 && round % SHOWCASE_EVERY === 0;
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
if (cmd !== "status" && cmd !== "fund" && (process.env.PORT || guestFunder())) startGuestServer(houseInfo);
(cmd === "status" ? status() : cmd === "fund" ? fund(process.argv[3] || "0.6") : run()).catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
