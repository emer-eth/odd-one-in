// Moves NEAR from a key file account in .keys/ to the parent account. tsx --env-file=.env scripts/sweep.ts <keyfile> <near>
import { readFileSync } from "node:fs";
import { nearToYocto } from "near-api-js";
import { accountFromKey, fmt, provider } from "./lib";
const [file, amt] = process.argv.slice(2);
const { accountId, secretKey } = JSON.parse(readFileSync(file, "utf8"));
await accountFromKey(accountId, secretKey).transfer({ receiverId: process.env.NEAR_ACCOUNT_ID!, amount: nearToYocto(amt) });
const a = await provider().viewAccount({ accountId: process.env.NEAR_ACCOUNT_ID! });
console.log(`✅ sent ${amt} NEAR from ${accountId}; ${process.env.NEAR_ACCOUNT_ID} now has ${fmt(a.amount)}`);
