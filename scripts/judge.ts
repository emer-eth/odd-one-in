// One command that checks what the README claims against the live contract and the house service.
//
//   npm run judge            read-only checks, about 20 seconds
//   npm run judge -- --play  also plays one whole round from a fresh guest account (seal, open, result): 6 to 9 minutes
//
// Nothing here needs a key or a .env: it reads the public contract, the public service, and (with --play)
// asks the service for a free guest account the same way the web app does.
import { createHash, randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, FailoverRpcProvider, type KeyPairString } from "near-api-js";
import { FOLLOW, REGULARS, contextFor, lean, type PastRound, type Result, type Side } from "../web/src/lib/regulars";

const CONTRACT = process.env.CONTRACT_ID || "ooi.yourname-swarm.testnet";
const SERVICE = (process.env.SERVICE_URL || "https://house-production-5c51fa04.up.railway.app").replace(/\/$/, "");
const SITE = "https://odd-one-in-zeta.vercel.app";
const rpc = new FailoverRpcProvider(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"].map((url) => new JsonRpcProvider({ url })));
const view = <T>(method: string, args: object = {}) => rpc.callFunction({ contractId: CONTRACT, method, args: args as Record<string, unknown> }) as Promise<T>;
const near = (y: string | bigint) => (Number(BigInt(y) / 10n ** 20n) / 10_000).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Cfg = { genesis_ts: string; round_duration_ns: string; stake: string; bond: string; fee_bps: number; streak_target: number; streak_bonus: string; pot_cap: string; storage_fee: string };
type Round = { id: number; phase: string; question: { text: string; a: string; b: string }; commits: number; revealed_a: number; revealed_b: number; outcome: Result | null };
type Entry = { committed: boolean; revealed: Side | null };
type Seat = { id: string; lean: Side | null; why: string };
type Reg = { id: string; name: string; account: string; balance: string; played: number; won: number; lost: number; kept: number; keptOf: number };
type Past = PastRound & { a: number; b: number; commits: number; question: Round["question"]; leans: Record<string, Side | null> };
type Regs = { round: number | null; follow: number; since: number; table: Seat[]; opening: { id: number; picks: Record<string, Side | null> } | null; regulars: Reg[]; rounds: Past[] };

let failed = 0;
let skipped = 0;
const ok = (what: string, detail = "") => console.log(`  ✅ ${what}${detail ? `  (${detail})` : ""}`);
const bad = (what: string, detail = "") => (failed++, console.log(`  ❌ ${what}${detail ? `  (${detail})` : ""}`));
const skip = (what: string, detail = "") => (skipped++, console.log(`  ➖ ${what}${detail ? `  (${detail})` : ""}`));
const check = (pass: boolean, what: string, detail = "") => (pass ? ok(what, detail) : bad(what, detail));

async function contract() {
  console.log(`\nContract ${CONTRACT}`);
  const cfg = await view<Cfg>("get_config");
  const mins = Number(BigInt(cfg.round_duration_ns) / 60_000_000_000n);
  ok("answers on testnet", `${mins}-minute rounds, stake ${near(cfg.stake)}, bond ${near(cfg.bond)}, fee ${cfg.fee_bps / 100}%`);
  const fee = (BigInt(cfg.stake) * BigInt(cfg.fee_bps)) / 10_000n;
  const bound = ((1n << BigInt(cfg.streak_target)) - 1n) * fee;
  check(BigInt(cfg.streak_bonus) < bound, "streak bonus is below the cost of forcing a streak with many wallets", `${near(cfg.streak_bonus)} < ${near(bound)} NEAR`);
  const pot = await view<string>("get_pot");
  check(BigInt(pot) <= BigInt(cfg.pot_cap), "streak pot is within its cap", `${near(pot)} of ${near(cfg.pot_cap)} NEAR`);
  const recent = await view<Round[]>("get_recent_rounds", { limit: 20 });
  check(recent.length > 0, "rounds have been played", `${recent.length} recent rounds with votes, latest ${recent[0]?.id}`);
  const wrong = recent.filter((r) => {
    const want: Result = r.revealed_a === r.revealed_b || !r.revealed_a || !r.revealed_b ? "Void" : r.revealed_a < r.revealed_b ? "A" : "B";
    return r.outcome !== want;
  });
  check(wrong.length === 0, "every recent round was won by the smaller side (or void on a tie or an empty side)", wrong.length ? `rounds ${wrong.map((r) => r.id).join(", ")} disagree` : `${recent.filter((r) => r.outcome !== "Void").length} decided, ${recent.filter((r) => r.outcome === "Void").length} void`);
  const t = await view<{ total_balances: string; locked: string; pot: string; fees: string }>("get_totals");
  const held = BigInt((await rpc.viewAccount({ accountId: CONTRACT })).amount);
  const owed = BigInt(t.total_balances) + BigInt(t.locked) + BigInt(t.pot) + BigInt(t.fees);
  check(held >= owed, "the contract holds at least what it owes players, the pot and fees", `holds ${near(held)}, owes ${near(owed)} NEAR`);
  return { cfg, recent };
}

async function service(recent: Round[]) {
  console.log(`\nHouse service ${SERVICE}`);
  let health: { ok: boolean; guests: { open: boolean; madeToday?: number; dailyLimit?: number; funderBalance?: string }; house: { lastRoundSeen: number } };
  let regs: Regs;
  try {
    health = (await (await fetch(`${SERVICE}/health`)).json()) as typeof health;
    regs = (await (await fetch(`${SERVICE}/regulars`)).json()) as Regs;
  } catch (e) {
    bad("service is reachable", e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!Array.isArray(regs.regulars)) {
    bad("service reports the regulars", "GET /regulars gave no list: the service is on an older version");
    return null;
  }
  const cur = await view<{ id: number; question: Round["question"] }>("get_current_round");
  check(health.ok && cur.id - health.house.lastRoundSeen <= 1, "service is up and following the chain", `on round ${health.house.lastRoundSeen}, chain is on ${cur.id}`);
  check(health.guests.open, "guest accounts are open (play with no wallet)", health.guests.open ? `${health.guests.madeToday} of ${health.guests.dailyLimit} made today, fund ${health.guests.funderBalance} NEAR` : "");

  console.log("\nThe regulars (NPCs with wallets)");
  check(regs.regulars.length === REGULARS.length, `${REGULARS.length} regulars, each a separate testnet account`, regs.regulars.map((r) => r.name).join(", "));
  const players = await Promise.all(regs.regulars.map((r) => view<{ balance: string } | null>("get_player", { account_id: r.account })));
  const off = regs.regulars.filter((r, i) => players[i]?.balance !== r.balance);
  check(off.length <= 1, "their game balances on chain match what the service reports", off.length ? `${off.map((r) => r.name).join(", ")} changed in the last few seconds` : `${near(players.reduce((s, p) => s + BigInt(p?.balance ?? 0), 0n))} NEAR in the game between them`);

  // This round's table: recompute every lean from the service's list of finished rounds, with the rules in regulars.ts.
  if (regs.round === cur.id && regs.table.length) {
    const ids = regs.table.map((s) => s.id);
    const mine = regs.table.map((s) => lean(s.id, contextFor(s.id, cur.id, cur.question, regs.rounds, ids)));
    const diff = regs.table.filter((s, i) => s.lean !== mine[i]);
    check(diff.length === 0, `this round's leans follow the published habits`, `round ${cur.id}: ${regs.table.map((s) => `${s.id} ${s.lean ?? "coin"}`).join(", ")}`);
  } else skip("this round's leans", "the table is set a few seconds into each round: run again");

  // Finished rounds: results must match the chain; picks must match the chain where the entry still exists
  // (the contract deletes an entry once its round is claimed); leans must match the published habits.
  const chain = new Map(recent.map((r) => [r.id, r]));
  const both = regs.rounds.filter((r) => chain.has(r.id));
  const misreported = both.filter((r) => chain.get(r.id)!.outcome !== r.result || chain.get(r.id)!.revealed_a !== r.a || chain.get(r.id)!.revealed_b !== r.b);
  if (both.length) check(misreported.length === 0, "results the service reports match the chain", `${both.length} rounds compared`);
  else skip("results the service reports match the chain", "the service has no finished rounds on record yet");
  const since = regs.rounds.filter((r) => r.id >= regs.since);
  let leanChecks = 0, leanBad = 0, kept = 0, keptOf = 0;
  for (const r of since) {
    const sat = Object.keys(r.picks);
    for (const id of sat) {
      const mine = lean(id, contextFor(id, r.id, r.question, regs.rounds, sat));
      leanChecks++;
      if (mine !== r.leans[id]) leanBad++;
      if (mine && r.picks[id]) { keptOf++; if (r.picks[id] === mine) kept++; }
    }
  }
  if (leanChecks) check(leanBad === 0, "past leans follow the published habits", `${leanChecks} leans recomputed over ${since.length} rounds`);
  else skip("past leans follow the published habits", `no finished rounds since habits began at round ${regs.since}`);
  if (keptOf >= 15) check(kept / keptOf > FOLLOW - 0.25 && kept / keptOf < 1, `regulars keep to their habit about ${Math.round(FOLLOW * 100)}% of the time, not always`, `${kept} of ${keptOf} picks, ${Math.round((kept / keptOf) * 100)}%`);
  else skip(`regulars keep to their habit about ${Math.round(FOLLOW * 100)}% of the time`, `${kept} of ${keptOf} so far: too few to judge`);

  // The round being opened right now: its entries are still on chain, so the picks can be checked directly.
  if (regs.opening && regs.opening.id === cur.id - 1 && Object.keys(regs.opening.picks).length) {
    const ids = Object.keys(regs.opening.picks);
    const entries = await Promise.all(ids.map((id) => view<Entry>("get_entry", { account_id: regs.regulars.find((r) => r.id === id)!.account, round_id: cur.id - 1 })));
    const diff = ids.filter((id, i) => entries[i].revealed !== regs.opening!.picks[id]);
    check(diff.length === 0, "picks being opened now match the chain", `round ${cur.id - 1}: ${ids.map((id) => `${id} ${regs.opening!.picks[id] ?? "sealed"}`).join(", ")}`);
  } else skip("picks being opened now match the chain", "the regulars aren't in the round being opened: they join when someone plays");
  return regs;
}

async function site() {
  console.log(`\nWeb app ${SITE}`);
  try {
    const html = await (await fetch(SITE)).text();
    const js = html.match(/assets\/index-[^"]+\.js/)?.[0];
    const src = js ? await (await fetch(`${SITE}/${js}`)).text() : "";
    check(src.includes(CONTRACT), "the live app talks to this contract");
    check(src.includes(SERVICE.replace("https://", "")), "the live app offers guest play through this service");
  } catch (e) {
    bad("the live app is reachable", e instanceof Error ? e.message : String(e));
  }
}

/** Plays one round end to end from a brand-new guest account, the way a visitor's browser does. */
async function play(cfg: Cfg) {
  console.log("\nA whole round from a fresh guest account");
  const kp = KeyPair.fromRandom("ed25519");
  const made = await fetch(`${SERVICE}/guest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey: kp.getPublicKey().toString() }) });
  const j = (await made.json()) as { accountId?: string; error?: string };
  if (!j.accountId) return bad("guest account created", j.error);
  ok("guest account created, no wallet", j.accountId);
  const me = new Account(j.accountId, rpc, KeyPairSigner.fromSecretKey(kp.toString() as KeyPairString));
  const T = 1_000_000_000_000n;
  const cost = BigInt(cfg.stake) + BigInt(cfg.bond);
  await me.callFunction({ contractId: CONTRACT, methodName: "deposit", args: {}, gas: 30n * T, deposit: cost + BigInt(cfg.storage_fee) });
  const dur = Number(BigInt(cfg.round_duration_ns) / 1_000_000n);
  const left = async () => {
    const c = await view<{ id: number; commit_ends_at: string }>("get_current_round");
    const now = Number(BigInt((await rpc.viewBlock({ finality: "final" })).header.timestamp_nanosec) / 1_000_000n);
    return { id: c.id, ms: Number(BigInt(c.commit_ends_at) / 1_000_000n) - now };
  };
  let at = await left();
  if (at.ms < 60_000) {
    console.log(`  … ${Math.round(at.ms / 1000)}s left in round ${at.id}: waiting for the next one`);
    await sleep(at.ms + 8_000);
    at = await left();
  }
  await sleep(8_000); // let the service set the table
  const regs = (await (await fetch(`${SERVICE}/regulars`)).json()) as Regs;
  const table = regs.round === at.id ? regs.table : [];
  const a = table.filter((s) => s.lean === "A").length, b = table.filter((s) => s.lean === "B").length;
  const side: Side = a < b ? "A" : a > b ? "B" : "A";
  const salt = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(`${at.id}:${j.accountId}:${side}:${salt}`, "utf8").digest("hex");
  const sealed = (await me.callFunction({ contractId: CONTRACT, methodName: "play", args: { reveal: null, commit: { round_id: at.id, hash } }, gas: 50n * T })) as { commit: { ok: boolean; error: string | null } };
  if (!sealed.commit?.ok) return bad("pick sealed", sealed.commit?.error ?? "");
  ok(`pick sealed in round ${at.id}`, `${side === "A" ? "orange" : "violet"}: the table leans ${a} orange, ${b} violet`);
  await sleep(30_000);
  const joined = (await view<{ commits: number }>("get_round", { id: at.id })).commits - 1;
  check(joined >= 3, "the regulars joined the round", `${joined} more sealed picks`);
  at = await left();
  console.log(`  … round closes in ${Math.round(at.ms / 1000)}s`);
  await sleep(at.ms + 10_000);
  const opened = (await me.callFunction({ contractId: CONTRACT, methodName: "play", args: { reveal: { round_id: at.id, choice: side, salt_hex: salt }, commit: null }, gas: 50n * T })) as { reveal: { ok: boolean; error: string | null } };
  check(!!opened.reveal?.ok, "pick opened in the next round, bond returned", opened.reveal?.error ?? "");
  console.log(`  … waiting ${Math.round(dur / 1000)}s for the round to be final`);
  await sleep(dur + 5_000);
  const claimed = (await me.callFunction({ contractId: CONTRACT, methodName: "claim", args: {}, gas: 60n * T })) as Array<{ round_id: number; result: string; credited: string }>;
  const mine = claimed.find((c) => c.round_id === at.id);
  const r = await view<Round>("get_round", { id: at.id });
  check(!!mine, "result collected", mine ? `${mine.result}: orange ${r.revealed_a}, violet ${r.revealed_b}, credited ${near(mine.credited)} NEAR` : "nothing to claim");
}

const { cfg, recent } = await contract();
await service(recent);
await site();
if (process.argv.includes("--play")) await play(cfg);
else console.log("\n  (add `-- --play` to also play one whole round from a fresh guest account: 6 to 9 minutes)");
console.log(`\n${failed ? `❌ ${failed} check${failed === 1 ? "" : "s"} failed` : "✅ all checks passed"}${skipped ? `, ${skipped} skipped (nothing to check yet)` : ""}\n`);
process.exit(failed ? 1 : 0);
