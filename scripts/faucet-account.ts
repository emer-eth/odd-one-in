// Creates one new testnet account funded by NEAR's faucet helper (the service near-cli's
// "sponsor-by-faucet-service" uses). The key is saved to .keys/ (git-ignored), never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { provider, fmt } from "./lib";

const id = process.argv[2];
if (!id?.endsWith(".testnet")) throw new Error("usage: tsx scripts/faucet-account.ts <name>.testnet");
const kp = KeyPair.fromRandom("ed25519");
const res = await fetch("https://helper.testnet.near.org/account", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
});
console.log("helper:", res.status, (await res.text()).slice(0, 200));
if (!res.ok) process.exit(1);
mkdirSync(".keys", { recursive: true });
writeFileSync(`.keys/${id}.json`, JSON.stringify({ accountId: id, secretKey: kp.toString() }, null, 2), { mode: 0o600 });
await new Promise((r) => setTimeout(r, 4000));
const a = await provider().viewAccount({ accountId: id });
console.log(`✅ ${id} balance ${fmt(a.amount)} NEAR (key in .keys/${id}.json)`);
