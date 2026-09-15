import {
  BITCOIN_FOR_STACKS,
  bitcoinAddressKind,
  capitalError,
  stacksAddressNetwork,
  type CapitalError,
  type ErrorCode,
  type StacksNetwork,
} from "@stacks-capital/core";

export type WalletId = "leather" | "xverse";

export function networkGuard(
  expected: StacksNetwork,
  addresses: { stx?: string; btc?: string[] },
): CapitalError | null {
  if (addresses.stx !== undefined && stacksAddressNetwork(addresses.stx) !== expected) {
    return capitalError("NETWORK_MISMATCH", "Stacks address is on the wrong network");
  }
  for (const btc of addresses.btc ?? []) {
    if (bitcoinAddressKind(btc) !== BITCOIN_FOR_STACKS[expected]) {
      return capitalError("NETWORK_MISMATCH", "Bitcoin address does not match the Stacks network");
    }
  }
  return null;
}

function errorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  if ("code" in error && typeof error.code === "number") return error.code;
  if ("error" in error) return errorCode(error.error);
  return null;
}

export function classifyWalletError(wallet: WalletId, error: unknown): ErrorCode {
  const code = errorCode(error);
  if (code === -32000 || code === -31001 || code === 4001) return "USER_REJECTED";
  if (code === -32601) return "UNSUPPORTED_WALLET";
  if (code === -32001 && wallet === "xverse") return "UNSUPPORTED_WALLET";
  return "UNCLASSIFIED";
}

export { BITCOIN_FOR_STACKS };
