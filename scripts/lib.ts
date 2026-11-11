// Shared NEAR helpers for the deploy and seed scripts. Testnet only.
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";

// FastNEAR first; dRPC and the (deprecated, rate-limited) near.org endpoint as fallbacks when it returns 429.
const RPC_URLS = process.env.NEAR_RPC_URL
  ? [process.env.NEAR_RPC_URL]
  : ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];

export const provider = () =>
  RPC_URLS.length > 1
    ? new FailoverRpcProvider(RPC_URLS.map((url) => new JsonRpcProvider({ url })))
    : new JsonRpcProvider({ url: RPC_URLS[0] });

export function parentAccount(): Account {
  const id = process.env.NEAR_ACCOUNT_ID;
  const key = process.env.NEAR_PRIVATE_KEY as KeyPairString | undefined;
  if (!id || !key) throw new Error("Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY (a testnet account) in .env");
  if (!id.endsWith(".testnet")) throw new Error(`Refusing to run on ${id}: testnet accounts only.`);
  return new Account(id, provider(), KeyPairSigner.fromSecretKey(key));
}

export const contractId = () => process.env.CONTRACT_ID || `ooi.${process.env.NEAR_ACCOUNT_ID}`;

export const accountFromKey = (accountId: string, secretKey: string) =>
  new Account(accountId, provider(), KeyPairSigner.fromSecretKey(secretKey as KeyPairString));

export const view = <T>(method: string, args: object = {}) =>
  provider().callFunction({ contractId: contractId(), method, args }) as Promise<T>;

export const NEAR = 10n ** 24n;
export const fmt = (yocto: bigint | string) => {
  const v = BigInt(yocto);
  const whole = v / NEAR;
  const frac = (v % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
