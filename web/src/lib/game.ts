// Commit hashes and salts. A salt never leaves this browser until the reveal.
import { CONTRACT_ID, NETWORK, type Choice } from "./near";

export type SaltRecord = { choice: Choice; salt_hex: string };

const saltId = (account: string, round: number) => `ooi:${NETWORK}:${CONTRACT_ID}:${account}:${round}`;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function newSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** sha256(utf8("{round_id}:{account_id}:{choice}:{salt_hex}")) as lowercase hex, same as the contract. */
export async function commitHash(round: number, account: string, choice: Choice, salt_hex: string): Promise<string> {
  const data = new TextEncoder().encode(`${round}:${account}:${choice}:${salt_hex}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** Returns false if the browser refused to store it (then the vote could not be opened later). */
export function saveSalt(account: string, round: number, rec: SaltRecord): boolean {
  try {
    localStorage.setItem(saltId(account, round), JSON.stringify(rec));
    return localStorage.getItem(saltId(account, round)) !== null;
  } catch {
    return false;
  }
}

export function loadSalt(account: string, round: number): SaltRecord | null {
  try {
    const raw = localStorage.getItem(saltId(account, round));
    return raw ? (JSON.parse(raw) as SaltRecord) : null;
  } catch {
    return null;
  }
}

export function deleteSalt(account: string, round: number) {
  try {
    localStorage.removeItem(saltId(account, round));
  } catch {
    /* ignore */
  }
}

const ERRORS: Record<string, string> = {
  NOT_REGISTERED: "Add NEAR to your balance first.",
  LOW_BALANCE: "Your game balance is too low. Top it up to play.",
  LOW_DEPOSIT: "That deposit is below the minimum.",
  ALREADY_COMMITTED: "You already sealed a vote for this round.",
  WRONG_PHASE: "The round changed while you were voting. Try again on the new question.",
  BAD_REVEAL: "Your vote couldn't be opened: the saved choice doesn't match what you sealed.",
  ALREADY_REVEALED: "That vote is already open.",
  NOT_DUE: "That round isn't finished yet.",
  NOT_OWNER: "Only the game owner can do that.",
  BAD_HASH: "The sealed vote was malformed. Try again.",
  TOO_MANY_PENDING: "You have 10 rounds waiting to be claimed. Claim them before playing again.",
  BAD_CONFIG: "Contract config error.",
};

/** Maps a contract error string (anywhere in an error message) to readable copy. */
export function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  for (const code of Object.keys(ERRORS)) if (msg.includes(code)) return ERRORS[code];
  if (/NotEnoughAllowance|allowance/i.test(msg)) return "Your one-tap play key ran out of gas allowance. Re-enable it below.";
  if (/User rejected|rejected|cancel/i.test(msg)) return "Cancelled in the wallet.";
  if (/does not exist|AccessKeyDoesNotExist|InvalidAccessKey/i.test(msg)) return "One-tap play isn't set up on this device. Enable it below.";
  if (/NotEnoughBalance|LackBalanceForState/i.test(msg)) return "Your wallet doesn't have enough NEAR for gas.";
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}
