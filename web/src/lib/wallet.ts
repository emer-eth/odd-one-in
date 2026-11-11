// Wallet connection (NEAR Connect). The wallet is used for exactly two things:
//   1. deposit (function-call keys can't attach NEAR), bundled with adding this browser's session key;
//   2. re-adding the session key on a new device or when its gas allowance runs out.
// Everything else is signed in the browser with the session key.
import { NearConnector, type NearWalletBase } from "@hot-labs/near-connect";
import { CONTRACT_ID, KEY_ALLOWANCE, KEY_METHODS, NETWORK, RPC_URLS, forgetSessionKey, sessionKey } from "./near";

let connector: NearConnector | null = null;

export function getConnector(): NearConnector {
  if (!connector) {
    connector = new NearConnector({
      network: NETWORK,
      providers: { [NETWORK]: RPC_URLS },
      features: { signAndSendTransactions: true },
    });
  }
  return connector;
}

export async function restoreAccount(): Promise<string | null> {
  try {
    const { accounts } = await getConnector().getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

export async function connectWallet(): Promise<string> {
  const wallet = await getConnector().connect();
  const accounts = await wallet.getAccounts({ network: NETWORK });
  if (!accounts[0]) throw new Error("No account returned by the wallet");
  return accounts[0].accountId;
}

export async function disconnectWallet() {
  await getConnector().disconnect().catch(() => {});
}

async function wallet(): Promise<NearWalletBase> {
  return (await getConnector().getConnectedWallet()).wallet;
}

const addKeyAction = (account: string) => ({
  type: "AddKey" as const,
  params: {
    publicKey: sessionKey(account).getPublicKey().toString(),
    accessKey: { permission: { receiverId: CONTRACT_ID, allowance: KEY_ALLOWANCE, methodNames: KEY_METHODS } },
  },
});

/** One wallet approval: add this browser's session key (if needed) and deposit into the game. */
export async function depositWithWallet(account: string, amountYocto: bigint, addKey: boolean) {
  const w = await wallet();
  const deposit = {
    receiverId: CONTRACT_ID,
    actions: [
      {
        type: "FunctionCall" as const,
        params: { methodName: "deposit", args: {}, gas: "30000000000000", deposit: amountYocto.toString() },
      },
    ],
  };
  const transactions = addKey ? [{ receiverId: account, actions: [addKeyAction(account)] }, deposit] : [deposit];
  await w.signAndSendTransactions({ network: NETWORK, signerId: account, transactions });
}

/**
 * Adds this browser's session key without depositing. If `replacePublicKey` is given (an old key whose
 * gas allowance ran out), it is deleted in the same transaction, after a fresh key is generated.
 */
export async function enableOneTap(account: string, replacePublicKey: string | null) {
  const w = await wallet();
  const actions: Array<ReturnType<typeof addKeyAction> | { type: "DeleteKey"; params: { publicKey: string } }> = [];
  if (replacePublicKey) {
    forgetSessionKey(account); // next sessionKey() call generates a new key
    actions.push({ type: "DeleteKey", params: { publicKey: replacePublicKey } });
  }
  actions.push(addKeyAction(account));
  await w.signAndSendTransactions({
    network: NETWORK,
    signerId: account,
    transactions: [{ receiverId: account, actions }],
  });
}
