export type StacksNetwork = "mainnet" | "testnet";
export type BitcoinNetworkKind = "mainnet" | "test" | "regtest";
export type Chain = "bitcoin" | "stacks";

/** Stacks testnet is anchored to Bitcoin regtest (I01). */
export const BITCOIN_FOR_STACKS: Readonly<Record<StacksNetwork, BitcoinNetworkKind>> = {
  mainnet: "mainnet",
  testnet: "regtest",
};

const C32 = "[0-9A-HJKMNP-TV-Z]";
const STACKS_MAINNET = new RegExp(`^S[PM]${C32}{38,40}$`);
const STACKS_TESTNET = new RegExp(`^S[TN]${C32}{38,40}$`);

export function stacksAddressNetwork(address: string): StacksNetwork | null {
  if (STACKS_MAINNET.test(address)) return "mainnet";
  if (STACKS_TESTNET.test(address)) return "testnet";
  return null;
}

const BECH32_DATA = "[023456789acdefghjklmnpqrstuvwxyz]{8,87}";
const BASE58_BODY = "[1-9A-HJ-NP-Za-km-z]{25,34}";

export function bitcoinAddressKind(address: string): BitcoinNetworkKind | null {
  const lower = address.toLowerCase();
  if (new RegExp(`^bcrt1${BECH32_DATA}$`).test(lower)) return "regtest";
  if (new RegExp(`^bc1${BECH32_DATA}$`).test(lower) || new RegExp(`^[13]${BASE58_BODY}$`).test(address)) return "mainnet";
  if (new RegExp(`^tb1${BECH32_DATA}$`).test(lower) || new RegExp(`^[mn2]${BASE58_BODY}$`).test(address)) return "test";
  return null;
}

export function requireNetwork(value: string | undefined): StacksNetwork {
  if (value === "mainnet" || value === "testnet") return value;
  throw new Error("Pass network testnet or mainnet. There is no default network.");
}
