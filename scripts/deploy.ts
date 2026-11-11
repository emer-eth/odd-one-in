// Deploys the contract to ooi.<NEAR_ACCOUNT_ID> on testnet and initialises it.
//   npm run deploy                    first deploy: creates the account, deploys, calls new()
//   npm run deploy -- --update        redeploys code only (state kept; only for state-compatible changes)
//   ROUND_MINUTES=3 npm run deploy    round length (default 3 for the demo; production is 1440)
// The contract account's key is written to .contract-keys/ (git-ignored), never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPair, nearToYocto } from "near-api-js";
import { accountFromKey, contractId, fmt, parentAccount, view } from "./lib";

const id = contractId();
const keyFile = `.contract-keys/${id}.json`;
const update = process.argv.includes("--update");
const roundMinutes = Number(process.env.ROUND_MINUTES || 3);
const wasm = readFileSync("contract/target/near/odd_one_in.wasm");
const questions = JSON.parse(readFileSync("scripts/questions.json", "utf8"));

const config = {
  round_duration_ns: String(BigInt(Math.round(roundMinutes * 60)) * 1_000_000_000n),
  stake: nearToYocto("0.1").toString(),
  bond: nearToYocto("0.1").toString(),
  fee_bps: 200,
  streak_target: 7,
  streak_bonus: nearToYocto("0.2").toString(), // sybil bound: 127 × 0.002 = 0.254
  pot_cap: nearToYocto("2").toString(),
  storage_fee: nearToYocto("0.02").toString(),
};

async function main() {
  if (!update) {
    if (existsSync(keyFile)) throw new Error(`${keyFile} exists: use --update to redeploy code`);
    const kp = KeyPair.fromRandom("ed25519");
    await parentAccount().createSubAccount({ accountOrPrefix: "ooi", publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto("2.5") });
    mkdirSync(".contract-keys", { recursive: true });
    writeFileSync(keyFile, JSON.stringify({ accountId: id, secretKey: kp.toString() }, null, 2), { mode: 0o600 });
    console.log(`✅ created ${id} with 2.5 NEAR (key in ${keyFile})`);
  }
  const { secretKey } = JSON.parse(readFileSync(keyFile, "utf8"));
  const contract = accountFromKey(id, secretKey);
  await contract.deployContract(new Uint8Array(wasm));
  console.log(`✅ deployed ${(wasm.length / 1024).toFixed(0)} KB`);
  if (!update) {
    // The parent account calls new(), so it becomes the owner (add_questions, withdraw_fees).
    await parentAccount().callFunction({ contractId: id, methodName: "new", args: { config, questions }, gas: 100_000_000_000_000n });
    console.log(`✅ initialised: ${roundMinutes}-minute rounds, ${questions.length} questions, owner ${process.env.NEAR_ACCOUNT_ID}`);
  }
  const cfg = await view<Record<string, unknown>>("get_config");
  const cur = await view<{ id: number; question: { text: string } }>("get_current_round");
  console.log("stake", fmt(String(cfg.stake)), "· bond", fmt(String(cfg.bond)), "· round", cur.id, "·", cur.question.text);
  console.log(`https://testnet.nearblocks.io/address/${id}`);
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
