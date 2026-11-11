// Seed players and play rounds against the testnet contract. Doubles as the integration test.
//
//   npm run seed -- setup --players 15         create seed-<i>.<NEAR_ACCOUNT_ID>, fund each, deposit once
//   npm run seed -- commit --a 6 --b 8 --unrevealed 1   commit a split to the current round
//   npm run seed -- reveal                      reveal last round's commits (skips the unrevealed ones)
//   npm run seed -- claim                       every seed player claims due rounds; prints results
//   npm run seed -- status                      round, pot, fees, totals, player balances
//   npm run seed -- loop --a 6 --b 8 --unrevealed 1     commit → wait → reveal → wait → claim → check the payout math
//
// Player keys go to .keys/seed.json and salts to scripts/salts.json (both git-ignored).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPair, nearToYocto } from "near-api-js";
import { accountFromKey, contractId, fmt, NEAR, parentAccount, provider, view } from "./lib";

type Choice = "A" | "B";
type SeedPlayer = { accountId: string; secretKey: string };
type SaltRec = { accountId: string; choice: Choice; salt_hex: string; reveal: boolean };
type Salts = Record<string, SaltRec[]>; // round id → commits
type Cfg = { genesis_ts: string; round_duration_ns: string; stake: string; bond: string; fee_bps: number; storage_fee: string };
type Totals = { total_balances: string; locked: string; pot: string; fees: string };
type ClaimItem = { round_id: number; outcome: string; choice: Choice | null; result: string; credited: string; bonus: string; streak: number };

const KEYS = ".keys/seed.json";
const SALTS = "scripts/salts.json";
// Prepaid gas is reserved up front at a pessimistic price, so keep it tight.
const TGAS = 1_000_000_000_000n;
const GAS: Record<string, bigint> = { deposit: 30n * TGAS, commit: 30n * TGAS, reveal: 30n * TGAS, claim: 60n * TGAS, play: 80n * TGAS };
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};

const load = <T>(file: string, def: T): T => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : def);
const players = () => load<SeedPlayer[]>(KEYS, []);
const salts = () => load<Salts>(SALTS, {});
const saveSalts = (s: Salts) => writeFileSync(SALTS, JSON.stringify(s, null, 2), { mode: 0o600 });
const signer = (p: SeedPlayer) => accountFromKey(p.accountId, p.secretKey);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RATE_LIMITED = /429|Rate limits|Exceeded \d+ providers/i;

/** Calls a contract method, retrying when the public RPC rate-limits. A retried commit/reveal that had
 *  already landed comes back ALREADY_COMMITTED / ALREADY_REVEALED, which counts as done. */
async function call<T = unknown>(p: SeedPlayer, methodName: string, args: object, deposit = 0n): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await signer(p).callFunction({ contractId: contractId(), methodName, args: args as Record<string, unknown>, gas: GAS[methodName] ?? 30n * TGAS, deposit })) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt > 0 && /ALREADY_COMMITTED|ALREADY_REVEALED/.test(msg)) return undefined as T;
      if (attempt >= 5 || !RATE_LIMITED.test(msg)) throw e;
      await sleep(8_000 * (attempt + 1));
    }
  }
}

/** Runs tasks with limited concurrency so the public RPC doesn't rate-limit us. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const hashOf = (round: number, accountId: string, choice: Choice, salt: string) =>
  createHash("sha256").update(`${round}:${accountId}:${choice}:${salt}`, "utf8").digest("hex");

async function chainClock() {
  const block = await provider().viewBlock({ finality: "final" });
  const cfg = await view<Cfg>("get_config");
  const now = BigInt(block.header.timestamp_nanosec);
  const dur = BigInt(cfg.round_duration_ns);
  const since = now - BigInt(cfg.genesis_ts);
  const round = Number(since / dur);
  const msLeft = Number((dur - (since % dur)) / 1_000_000n);
  return { round, msLeft, cfg };
}

/** Waits until the chain is in `round` with at least `marginMs` of it left. */
async function waitForRound(round: number, marginMs = 25_000) {
  for (;;) {
    const c = await chainClock();
    if (c.round > round) throw new Error(`missed round ${round} (now ${c.round})`);
    if (c.round === round && c.msLeft > marginMs) return c;
    const wait = c.round === round ? c.msLeft + 3_000 : c.msLeft + 3_000;
    console.log(`  … waiting ${Math.ceil(wait / 1000)}s for round ${round}`);
    await sleep(Math.min(wait, 30_000));
  }
}

async function setup() {
  const n = opt("players", 5);
  const existing = players();
  const { cfg } = await chainClock();
  const firstDeposit = BigInt(cfg.stake) + BigInt(cfg.bond) + BigInt(cfg.storage_fee);
  const fund = firstDeposit + nearToYocto("0.1"); // account storage + liquid NEAR for gas reserves
  const parent = parentAccount();
  mkdirSync(".keys", { recursive: true });
  // Finish players created by an earlier run whose deposit didn't go through, and top up
  // players whose game balance can't cover another round.
  const roundCost = BigInt(cfg.stake) + BigInt(cfg.bond);
  for (const p of existing.slice(0, n)) {
    const pl = await view<{ balance: string } | null>("get_player", { account_id: p.accountId });
    if (!pl) {
      await call(p, "deposit", {}, firstDeposit);
      console.log(`✅ ${p.accountId}: deposited ${fmt(firstDeposit)}`);
    } else if (BigInt(pl.balance) < roundCost) {
      await parent.transfer({ receiverId: p.accountId, amount: roundCost });
      await call(p, "deposit", {}, roundCost);
      console.log(`✅ ${p.accountId}: topped up ${fmt(roundCost)}`);
    }
  }
  for (let i = existing.length; i < n; i++) {
    const kp = KeyPair.fromRandom("ed25519");
    const prefix = `seed-${i}`;
    await parent.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey(), nearToTransfer: fund });
    const p = { accountId: `${prefix}.${process.env.NEAR_ACCOUNT_ID}`, secretKey: kp.toString() };
    existing.push(p);
    writeFileSync(KEYS, JSON.stringify(existing, null, 2), { mode: 0o600 });
    await call(p, "deposit", {}, firstDeposit);
    console.log(`✅ ${p.accountId}: funded ${fmt(fund)}, deposited ${fmt(firstDeposit)}`);
  }
  console.log(`${existing.length} seed players ready`);
}

async function commit(a: number, b: number, unrevealed: number, round?: number) {
  const ps = players();
  if (a + b + unrevealed > ps.length) throw new Error(`need ${a + b + unrevealed} players, have ${ps.length}: run setup`);
  const c = round === undefined ? await waitForRound((await chainClock()).round) : await waitForRound(round);
  const r = c.round;
  const recs: SaltRec[] = ps.slice(0, a + b + unrevealed).map((p, i) => ({
    accountId: p.accountId,
    choice: i < a ? "A" : i < a + b ? "B" : Math.random() < 0.5 ? "A" : "B",
    salt_hex: randomBytes(32).toString("hex"),
    reveal: i < a + b,
  }));
  // Save salts before sending, like the web app does.
  const s = salts();
  s[r] = recs;
  saveSalts(s);
  await pool(recs, 2, (rec) => {
    const p = ps.find((x) => x.accountId === rec.accountId)!;
    return call(p, "commit", { round_id: r, hash: hashOf(r, rec.accountId, rec.choice, rec.salt_hex) });
  });
  console.log(`✅ round ${r}: committed ${a} A, ${b} B, ${unrevealed} that will not reveal`);
  return r;
}

async function reveal() {
  const { round } = await chainClock();
  const r = round - 1;
  const recs = (salts()[r] || []).filter((x) => x.reveal);
  if (!recs.length) return console.log(`nothing to reveal for round ${r}`);
  const ps = players();
  await pool(recs, 2, (rec) => {
    const p = ps.find((x) => x.accountId === rec.accountId)!;
    return call(p, "reveal", { round_id: r, choice: rec.choice, salt_hex: rec.salt_hex });
  });
  const view_ = await view<{ revealed_a: number; revealed_b: number }>("get_round", { id: r });
  console.log(`✅ round ${r}: revealed ${recs.length} · tally A ${view_.revealed_a} / B ${view_.revealed_b}`);
}

async function claim() {
  const ps = players();
  const results = await pool(ps, 2, async (p) => {
    const before = await view<{ balance: string } | null>("get_player", { account_id: p.accountId });
    const items = await call<ClaimItem[]>(p, "claim", {});
    const after = await view<{ balance: string } | null>("get_player", { account_id: p.accountId });
    return { p, items, delta: BigInt(after?.balance ?? 0) - BigInt(before?.balance ?? 0) };
  });
  for (const { p, items, delta } of results) {
    if (!items.length) continue;
    const summary = items.map((i) => `r${i.round_id} ${i.choice ?? "-"}→${i.outcome} ${i.result} +${fmt(i.credited)}${i.bonus !== "0" ? ` bonus ${fmt(i.bonus)}` : ""}`).join(", ");
    console.log(`  ${p.accountId.split(".")[0]}: ${summary} (balance ${delta >= 0n ? "+" : ""}${fmt(delta)})`);
  }
  return results;
}

async function status() {
  const { round, msLeft, cfg } = await chainClock();
  const cur = await view<{ question: { text: string }; commits: number }>("get_current_round");
  const t = await view<Totals>("get_totals");
  const acct = await provider().viewAccount({ accountId: contractId() });
  console.log(`round ${round} (${Math.round(msLeft / 1000)}s left): "${cur.question.text}" · ${cur.commits} sealed`);
  console.log(`pot ${fmt(t.pot)} · fees ${fmt(t.fees)} · balances ${fmt(t.total_balances)} · locked ${fmt(t.locked)}`);
  const owed = BigInt(t.pot) + BigInt(t.fees) + BigInt(t.total_balances) + BigInt(t.locked);
  const storage = BigInt(acct.storage_usage) * 10n ** 19n;
  const free = BigInt(acct.amount) - storage;
  console.log(`contract balance ${fmt(acct.amount)} · storage ${fmt(storage)} · free ${fmt(free)} · owed ${fmt(owed)} → ${free >= owed ? "✅ solvent" : "❌ SHORT"}`);
  for (const p of players()) {
    const pl = await view<{ balance: string; streak: number; pending: number[] } | null>("get_player", { account_id: p.accountId });
    if (pl) console.log(`  ${p.accountId.split(".")[0]}: ${fmt(pl.balance)} · streak ${pl.streak} · pending [${pl.pending.join(",")}]`);
  }
  void cfg;
}

/** Full round trip, checked against the payout rules (spec 3.4). */
async function loop(a: number, b: number, u: number) {
  const r = await commit(a, b, u);
  await waitForRound(r + 1, 15_000);
  await reveal();
  await waitForRound(r + 2, 0);
  const { cfg } = await chainClock();
  const before = await view<Totals>("get_totals");
  const results = await claim();
  const after = await view<Totals>("get_totals");

  const s = BigInt(cfg.stake);
  const bond = BigInt(cfg.bond);
  const fee = (s * BigInt(cfg.fee_bps)) / 10_000n;
  const m = BigInt(Math.min(a, b));
  const M = BigInt(Math.max(a, b));
  const voidRound = a === b || a === 0 || b === 0;
  const expPot = (voidRound ? 0n : (M - m) * s) + BigInt(u) * (s + bond);
  const expFees = voidRound ? 0n : m * fee;
  const winner: Choice = a < b ? "A" : "B";
  const recs = salts()[r];
  let paidWinners = 0n;
  let ok = true;
  for (const { p, items } of results) {
    const it = items.find((i) => i.round_id === r);
    const rec = recs.find((x) => x.accountId === p.accountId);
    if (!rec) continue;
    const exp = !rec.reveal ? 0n : voidRound ? s : rec.choice === winner ? 2n * s - fee : 0n;
    const got = BigInt(it?.credited ?? 0);
    if (got !== exp) {
      ok = false;
      console.log(`❌ ${p.accountId}: credited ${fmt(got)}, expected ${fmt(exp)}`);
    }
    if (!voidRound && rec.reveal && rec.choice === winner) paidWinners += got;
  }
  const potDelta = BigInt(after.pot) - BigInt(before.pot);
  const feeDelta = BigInt(after.fees) - BigInt(before.fees);
  // If the pot hit its cap, the overflow went to fees: check the sum instead.
  const potFeesOk = potDelta === expPot && feeDelta === expFees ? true : potDelta + feeDelta === expPot + expFees;
  ok &&= potFeesOk;
  console.log(`winners paid ${fmt(paidWinners)} · pot +${fmt(potDelta)} (expected ${fmt(expPot)}) · fees +${fmt(feeDelta)} (expected ${fmt(expFees)})`);
  const moneyIn = BigInt(a + b + u) * s + BigInt(u) * bond;
  const moneyOut = (voidRound ? BigInt(a + b) * s : paidWinners) + potDelta + feeDelta;
  console.log(`money in ${fmt(moneyIn)} · money out ${fmt(moneyOut)} → ${moneyIn === moneyOut ? "✅ conserved" : "❌ mismatch"}`);
  ok &&= moneyIn === moneyOut;
  await status();
  if (!ok) throw new Error("payout check failed");
  console.log("✅ loop passed");
}

async function main() {
  const a = opt("a", 2);
  const b = opt("b", 3);
  const u = opt("unrevealed", 0);
  if (cmd === "setup") await setup();
  else if (cmd === "commit") await commit(a, b, u);
  else if (cmd === "reveal") await reveal();
  else if (cmd === "claim") await claim();
  else if (cmd === "status") await status();
  else if (cmd === "loop") await loop(a, b, u);
  else console.log("usage: npm run seed -- setup|commit|reveal|claim|status|loop [--players N] [--a N --b N --unrevealed N]");
  void NEAR;
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
