// Chain access: views go straight to the RPC; daily actions are signed in the browser with a
// function-call access key that can only call the game's methods (no NEAR can be attached).
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";

export const NETWORK = (import.meta.env.VITE_NETWORK || "testnet") as "testnet" | "mainnet";
export const CONTRACT_ID: string = import.meta.env.VITE_CONTRACT_ID || "ooi.yourname-swarm.testnet";

// Public RPCs, tried in order. A rate-limited reply (429) has no CORS headers, so the browser sees it as a
// network error: we move to the next endpoint at once instead of retrying the same one.
export const RPC_URLS =
  NETWORK === "testnet"
    ? ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]
    : ["https://rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com"];

let good = 0; // index of the last endpoint that answered
const providers = RPC_URLS.map((url) => new JsonRpcProvider({ url }));
/** Provider for signing: the endpoint that last answered. */
export const currentProvider = () => providers[good];

type RpcError = Error & { rpc?: true };

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (let i = 0; i < RPC_URLS.length; i++) {
    const idx = (good + i) % RPC_URLS.length;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    try {
      const res = await fetch(RPC_URLS[idx], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ooi", method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) {
        // A rate limit can also arrive as a JSON-RPC error: rotate. Anything else is a real answer.
        if (j.error.code === -429 || /rate limit/i.test(JSON.stringify(j.error))) throw new Error("rate limited");
        const e: RpcError = new Error(JSON.stringify(j.error));
        e.rpc = true;
        throw e;
      }
      good = idx;
      return j.result as T;
    } catch (e) {
      if ((e as RpcError).rpc) throw e;
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last instanceof Error ? last : new Error("NEAR RPC unreachable");
}

export const EXPLORER = NETWORK === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io";

/** Methods the session key may call. `deposit` is not here: function-call keys can't attach NEAR. */
export const KEY_METHODS = ["play", "commit", "reveal", "claim", "settle", "withdraw"];
/** Gas budget the key may burn before it must be re-approved. */
export const KEY_ALLOWANCE = "2000000000000000000000000"; // 2 NEAR: a cap on gas spend, not a deposit
const TGAS = 1_000_000_000_000n;

// ---------- types mirroring the contract ----------

export type Choice = "A" | "B";
export type Outcome = "A" | "B" | "Void";
export type Question = { text: string; a: string; b: string };
export type Config = {
  owner: string;
  genesis_ts: string;
  round_duration_ns: string;
  stake: string;
  bond: string;
  fee_bps: number;
  streak_target: number;
  streak_bonus: string;
  pot_cap: string;
  storage_fee: string;
};
export type CurrentRound = { id: number; commit_ends_at: string; question: Question; commits: number };
export type Phase = "Future" | "Commit" | "Reveal" | "Settled";
export type RoundView = {
  id: number;
  phase: Phase;
  question: Question;
  commits: number;
  revealed_a: number;
  revealed_b: number;
  outcome: Outcome | null;
  settled: boolean;
  starts_at: string;
};
export type Player = { balance: string; streak: number; best_streak: number; pending: number[] };
export type EntryView = { committed: boolean; revealed: Choice | null };
export type ClaimItem = {
  round_id: number;
  outcome: Outcome;
  choice: Choice | null;
  result: "Win" | "Lose" | "Void" | "Forfeit";
  credited: string;
  bonus: string;
  streak: number;
};
export type StepResult = { ok: boolean; error: string | null };
export type PlayResult = { claimed: ClaimItem[]; reveal: StepResult | null; commit: StepResult | null };

// ---------- views ----------

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: CONTRACT_ID,
    method_name: method,
    args_base64: b64(JSON.stringify(args)),
  });
  if (r.error || !r.result) throw new Error(r.error || "empty view result");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}

export async function chainTimeNs(): Promise<bigint> {
  const block = await rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "optimistic" });
  return BigInt(block.header.timestamp_nanosec);
}

// ---------- session key (function-call access key held in this browser) ----------

const keyStorageId = (account: string) => `ooi:${NETWORK}:${CONTRACT_ID}:${account}:key`;

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked: the key lives only for this page */
  }
}
function lsDel(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Returns this browser's key for the account, creating (but not yet registering) one if needed. */
export function sessionKey(account: string): KeyPair {
  const stored = lsGet(keyStorageId(account));
  if (stored) return KeyPair.fromString(stored as KeyPairString);
  const kp = KeyPair.fromRandom("ed25519");
  lsSet(keyStorageId(account), kp.toString());
  return kp;
}

export const forgetSessionKey = (account: string) => lsDel(keyStorageId(account));

/** True if this browser's key is on chain as a function-call key for the game. */
export async function sessionKeyActive(account: string): Promise<boolean> {
  if (!lsGet(keyStorageId(account))) return false;
  try {
    const k = await rpc<{ permission?: unknown; error?: string }>("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: account,
      public_key: sessionKey(account).getPublicKey().toString(),
    });
    return typeof k.permission === "object" && k.permission !== null && "FunctionCall" in k.permission;
  } catch {
    return false; // not found comes back as an RPC error
  }
}

/** Calls a game method signed by the session key: no wallet popup. */
export async function callWithKey<T>(account: string, methodName: string, args: Record<string, unknown>, gasTgas = 60): Promise<T> {
  const signer = KeyPairSigner.fromSecretKey(sessionKey(account).toString() as KeyPairString);
  const acct = new Account(account, currentProvider(), signer);
  return (await acct.callFunction({ contractId: CONTRACT_ID, methodName, args, gas: BigInt(gasTgas) * TGAS })) as T;
}

// ---------- money formatting ----------

const YOCTO = 10n ** 24n;
export function fmtNear(yocto: string | bigint, digits = 3): string {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / YOCTO;
  const frac = (a % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? "." + frac : ""}`;
}
export function parseNear(s: string): bigint {
  const [w, f = ""] = s.trim().split(".");
  if (!/^\d+$/.test(w || "0") || !/^\d*$/.test(f)) throw new Error("Enter an amount like 0.5");
  return BigInt(w || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24));
}
