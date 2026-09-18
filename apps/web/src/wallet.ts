import { stacksAddressNetwork, type StacksNetwork } from "@stacks-capital/core";
import type { WalletId } from "@stacks-capital/wallets";
import type { ConnectedWallet, MessageSigner } from "./session.ts";

export type WalletProvider = { request(method: string, params?: unknown): Promise<unknown> };

// I02: Xverse answers Stacks methods on BitcoinProvider, and its wallet_connect only accepts capitalised networks.
const XVERSE_NETWORK: Record<StacksNetwork, string> = { mainnet: "Mainnet", testnet: "Testnet" };

export function findProvider(id: WalletId, root: Record<string, unknown> = globalThis as never): WalletProvider | null {
  const candidate =
    id === "leather"
      ? (root.LeatherProvider ?? (root.btc as Record<string, unknown> | undefined))
      : ((root.XverseProviders as Record<string, unknown> | undefined)?.BitcoinProvider ?? root.XverseProviders);
  return typeof (candidate as WalletProvider | undefined)?.request === "function"
    ? (candidate as WalletProvider)
    : null;
}

export function installedWallets(root?: Record<string, unknown>): WalletId[] {
  return (["leather", "xverse"] as const).filter((id) => findProvider(id, root) !== null);
}

/** Wallets answer in several shapes, so the Stacks address is found by what it is, not by where it sits. */
export function findStacksAddress(payload: unknown, seen = new Set<unknown>()): string | null {
  if (typeof payload === "string") return stacksAddressNetwork(payload) === null ? null : payload;
  if (typeof payload !== "object" || payload === null || seen.has(payload)) return null;
  seen.add(payload);
  for (const value of Object.values(payload as Record<string, unknown>)) {
    const found = findStacksAddress(value, seen);
    if (found !== null) return found;
  }
  return null;
}

export async function connectWallet(
  id: WalletId,
  network: StacksNetwork,
  provider: WalletProvider | null = findProvider(id),
): Promise<ConnectedWallet> {
  if (provider === null) throw new Error(`${id} is not installed`);
  const answer =
    id === "xverse"
      ? await provider.request("wallet_connect", { addresses: ["stacks"], network: XVERSE_NETWORK[network] })
      : await provider.request("getAddresses", { network });

  const address = findStacksAddress(answer);
  if (address === null) throw new Error(`${id} returned no Stacks address`);
  const walletNetwork = stacksAddressNetwork(address);
  if (walletNetwork === null) throw new Error(`${id} returned an address this app cannot read`);
  return { id, address, network: walletNetwork };
}

export function messageSigner(id: WalletId, provider: WalletProvider | null = findProvider(id)): MessageSigner {
  return async (message: string) => {
    if (provider === null) throw new Error(`${id} is not installed`);
    const answer = (await provider.request("stx_signMessage", { message })) as {
      signature?: string;
      publicKey?: string;
      result?: { signature?: string; publicKey?: string };
    };
    const signature = answer.signature ?? answer.result?.signature;
    const publicKey = answer.publicKey ?? answer.result?.publicKey;
    if (signature === undefined || publicKey === undefined) throw new Error(`${id} returned no signature`);
    return { signature, publicKey };
  };
}
