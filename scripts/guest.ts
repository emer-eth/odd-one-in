// Guest accounts: lets a visitor play without a wallet.
//
// The browser makes a key pair and sends only the PUBLIC key here. This server creates a throwaway testnet
// account for it (a sub-account of the guest funder) with a little test NEAR, and the browser then signs
// everything itself. The funder's key is also added to each guest account, so unused test NEAR can be
// reclaimed later. Testnet only: there is no real money in a guest account.
//
//   GUEST_FUNDER       JSON { accountId, secretKey } of the account that pays (or GUEST_FUNDER_FILE, a path)
//   GUEST_GRANT        NEAR given to each guest (default 0.5)
//   GUEST_DAILY        guest accounts per UTC day, all visitors together (default 40)
//   GUEST_PER_IP       guest accounts per UTC day from one address (default 3)
//   GUEST_ORIGINS      comma-separated web origins allowed to call this (default: the live site and localhost)
//   PORT               port to listen on (default 8787)
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { actions, nearToYocto, PublicKey, KeyPairSigner, type KeyPairString } from "near-api-js";
import { accountFromKey, contractId, fmt, provider } from "./lib";

type Funder = { accountId: string; secretKey: string };

export function guestFunder(): Funder | null {
  const raw = process.env.GUEST_FUNDER || (process.env.GUEST_FUNDER_FILE && existsSync(process.env.GUEST_FUNDER_FILE) ? readFileSync(process.env.GUEST_FUNDER_FILE, "utf8") : "");
  if (!raw) return null;
  const f = JSON.parse(raw) as Funder;
  if (!f.accountId?.endsWith(".testnet")) throw new Error(`Refusing to fund guests from ${f.accountId}: testnet accounts only.`);
  return f;
}

const GRANT = nearToYocto((process.env.GUEST_GRANT || "0.5") as `${number}`);
const DAILY = Number(process.env.GUEST_DAILY || 40);
const PER_IP = Number(process.env.GUEST_PER_IP || 3);
/** Keep this much in the funder so it can always pay gas (and so a drained faucet fails with a clear message). */
const RESERVE = nearToYocto("0.5");
const ORIGINS = (process.env.GUEST_ORIGINS || "https://odd-one-in-zeta.vercel.app,http://localhost:5173,http://localhost:4173").split(",").map((s) => s.trim());

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "guest:", ...a);
const today = () => new Date().toISOString().slice(0, 10);

let day = today();
let madeToday = 0;
const perIp = new Map<string, number>();
const byKey = new Map<string, string>(); // public key -> account id (a repeat request returns the same account)
let queue: Promise<unknown> = Promise.resolve(); // one transaction at a time: they share the funder's key nonce

function rollDay() {
  if (day !== today()) {
    day = today();
    madeToday = 0;
    perIp.clear();
  }
}

class Refusal extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function create(funder: Funder, publicKey: string, ip: string): Promise<string> {
  rollDay();
  const known = byKey.get(publicKey);
  if (known) return known;
  let pk: PublicKey;
  try {
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(publicKey)) throw new Error("shape");
    pk = PublicKey.fromString(publicKey);
  } catch {
    throw new Refusal(400, "That isn't a valid public key.");
  }
  if (madeToday >= DAILY) throw new Refusal(429, "Today's guest accounts are all taken. Connect a NEAR testnet wallet to play, or come back tomorrow.");
  if ((perIp.get(ip) ?? 0) >= PER_IP) throw new Refusal(429, "You've already made guest accounts today. Connect a NEAR testnet wallet to keep playing.");
  const payer = accountFromKey(funder.accountId, funder.secretKey);
  const have = BigInt((await provider().viewAccount({ accountId: funder.accountId })).amount);
  if (have < GRANT + RESERVE) throw new Refusal(503, "The guest faucet is empty right now. Connect a NEAR testnet wallet to play.");
  // Count before sending so a burst can't overshoot the caps.
  madeToday++;
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  const accountId = `g-${randomBytes(5).toString("hex")}.${funder.accountId}`;
  try {
    const own = KeyPairSigner.fromSecretKey(funder.secretKey as KeyPairString);
    await payer.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(GRANT), actions.addFullAccessKey(pk), actions.addFullAccessKey(await own.getPublicKey())],
    });
  } catch (e) {
    madeToday--;
    perIp.set(ip, (perIp.get(ip) ?? 1) - 1);
    throw e;
  }
  byKey.set(publicKey, accountId);
  log(`${accountId} created (${madeToday}/${DAILY} today)`);
  return accountId;
}

function send(res: ServerResponse, origin: string | undefined, status: number, body: unknown) {
  const allow = origin && ORIGINS.includes(origin) ? origin : ORIGINS[0];
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2000) throw new Refusal(413, "Too large.");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Refusal(400, "Send JSON.");
  }
}

/** Starts the guest API. `houseInfo` adds the house players' state to /health. */
export function startGuestServer(houseInfo: () => Record<string, unknown> = () => ({})) {
  const funder = guestFunder();
  const port = Number(process.env.PORT || 8787);
  createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      if (req.method === "OPTIONS") return send(res, origin, 204, {});
      const path = (req.url || "/").split("?")[0];
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        rollDay();
        const balance = funder ? fmt((await provider().viewAccount({ accountId: funder.accountId })).amount).slice(0, 7) : null;
        return send(res, origin, 200, { ok: true, contract: contractId(), guests: funder ? { open: true, grant: fmt(GRANT), madeToday, dailyLimit: DAILY, funder: funder.accountId, funderBalance: balance } : { open: false }, house: houseInfo() });
      }
      if (req.method === "POST" && path === "/guest") {
        if (!funder) throw new Refusal(503, "Guest accounts aren't switched on.");
        if (origin && !ORIGINS.includes(origin)) throw new Refusal(403, "Not allowed from this site.");
        const { publicKey } = await body(req);
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
        const job = queue.then(() => create(funder, String(publicKey || ""), ip));
        queue = job.catch(() => {});
        return send(res, origin, 201, { accountId: await job, grant: fmt(GRANT) });
      }
      send(res, origin, 404, { error: "Not found." });
    } catch (e) {
      if (e instanceof Refusal) return send(res, origin, e.status, { error: e.message });
      log("failed:", e instanceof Error ? e.message.slice(0, 200) : e);
      send(res, origin, 502, { error: "Couldn't create a guest account just now. Try again in a moment." });
    }
  }).listen(port, () => log(`listening on :${port}, guests ${funder ? `funded by ${funder.accountId}, ${fmt(GRANT)} NEAR each, ${DAILY} a day` : "off (no GUEST_FUNDER)"}`));
}
