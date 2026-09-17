export type StacksNetwork = "mainnet" | "testnet";
export type BitcoinAddressKind = "mainnet" | "test" | "regtest";
export type WalletId = "leather" | "xverse";

// Subset of the page 06 error contract that a wallet interaction can produce, plus UNCLASSIFIED for anything not yet observed.
export type ProductError = "USER_REJECTED" | "NETWORK_MISMATCH" | "UNSUPPORTED_WALLET" | "UNCLASSIFIED";

export type WalletOutcome = "BROADCAST" | "SIGNED" | "UNKNOWN";

const C32 = "[0-9A-HJKMNP-TV-Z]";
const STACKS_MAINNET = new RegExp(`^S[PM]${C32}{38,40}$`);
const STACKS_TESTNET = new RegExp(`^S[TN]${C32}{38,40}$`);

export function stacksAddressNetwork(address: string): StacksNetwork | null {
  if (STACKS_MAINNET.test(address)) return "mainnet";
  if (STACKS_TESTNET.test(address)) return "testnet";
  return null;
}

const BECH32_BODY = "[02-9ac-hj-np-z]{8,87}";
const BASE58_BODY = "[1-9A-HJ-NP-Za-km-z]{25,34}";

// tb1 is shared by testnet3, testnet4 and signet, so those cannot be told apart from an address alone.
export function bitcoinAddressKind(address: string): BitcoinAddressKind | null {
  const lower = address.toLowerCase();
  if (new RegExp(`^bcrt1${BECH32_BODY}$`).test(lower)) return "regtest";
  if (new RegExp(`^bc1${BECH32_BODY}$`).test(lower) || new RegExp(`^[13]${BASE58_BODY}$`).test(address))
    return "mainnet";
  if (new RegExp(`^tb1${BECH32_BODY}$`).test(lower) || new RegExp(`^[mn2]${BASE58_BODY}$`).test(address)) return "test";
  return null;
}

// Stacks testnet is anchored to Bitcoin regtest (I01 finding), so testnet BTC addresses must be regtest.
export const BITCOIN_FOR_STACKS: Readonly<Record<StacksNetwork, BitcoinAddressKind>> = {
  mainnet: "mainnet",
  testnet: "regtest",
};

export function networkGuard(
  expected: StacksNetwork,
  addresses: { stx?: string; btc?: string[] },
): ProductError | null {
  if (addresses.stx !== undefined && stacksAddressNetwork(addresses.stx) !== expected) return "NETWORK_MISMATCH";
  for (const btc of addresses.btc ?? []) {
    if (bitcoinAddressKind(btc) !== BITCOIN_FOR_STACKS[expected]) return "NETWORK_MISMATCH";
  }
  return null;
}

function errorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  if ("code" in error && typeof error.code === "number") return error.code;
  if ("error" in error) return errorCode(error.error);
  return null;
}

// -32001 means "address mismatch" in @stacks/connect but "method not supported" in sats-connect, so it depends on the wallet.
export function classifyWalletError(wallet: WalletId, error: unknown): ProductError {
  const code = errorCode(error);
  // Leather rejects with 4001 (observed in I02), not the -32000 that @stacks/connect documents.
  if (code === -32000 || code === -31001 || code === 4001) return "USER_REJECTED";
  if (code === -32601) return "UNSUPPORTED_WALLET";
  if (code === -32001 && wallet === "xverse") return "UNSUPPORTED_WALLET";
  return "UNCLASSIFIED";
}

// Page 06: a wallet result may be signed, broadcast or unknown. UNKNOWN must lead to a chain lookup, never a retry.
export function walletOutcome(result: unknown): WalletOutcome {
  if (typeof result !== "object" || result === null) return "UNKNOWN";
  if ("txid" in result && typeof result.txid === "string" && result.txid.length > 0) return "BROADCAST";
  if ("transaction" in result && typeof result.transaction === "string") return "SIGNED";
  if ("psbt" in result && typeof result.psbt === "string") return "SIGNED";
  return "UNKNOWN";
}
