// One-off: send NEAR from the parent to a seed player. npm exec tsx -- --env-file=.env scripts/topup.ts <accountId> <near>
import { nearToYocto } from "near-api-js";
import { parentAccount } from "./lib";
const [id, amt] = process.argv.slice(2);
await parentAccount().transfer({ receiverId: id, amount: nearToYocto(amt) });
console.log(`✅ sent ${amt} NEAR to ${id}`);
