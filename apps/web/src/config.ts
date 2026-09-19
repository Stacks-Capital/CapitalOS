import { requireNetwork, type StacksNetwork } from "@stacks-capital/core";

export type WebConfig = { apiBaseUrl: string; clientId: string; network: StacksNetwork };

export const NETWORKS = ["mainnet", "testnet"] as const;

type Env = Record<string, string | undefined>;

/**
 * Only publishable values reach the bundle: the API URL, the client id and the starting network.
 * An API key would be a secret, and the client refuses one in a browser anyway (I07).
 * The in-app switcher can move between mainnet and testnet without rebuilding.
 */
export function readConfig(env: Env): WebConfig {
  const apiBaseUrl = env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
  const clientId = env.VITE_CLIENT_ID ?? "";
  if (clientId === "") throw new Error("VITE_CLIENT_ID is not set. Copy .env.example to .env.local.");
  return { apiBaseUrl, clientId, network: requireNetwork(env.VITE_NETWORK ?? "mainnet") };
}

export function testnetNote(network: StacksNetwork): string | null {
  if (network !== "testnet") return null;
  return "Testnet writes stay disabled. Markets still list, and each action says why.";
}
