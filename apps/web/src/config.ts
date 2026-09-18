import { requireNetwork, type StacksNetwork } from "@stacks-capital/core";

export type WebConfig = { apiBaseUrl: string; clientId: string; network: StacksNetwork };

type Env = Record<string, string | undefined>;

/**
 * Only publishable values reach the bundle: the API URL, the client id and the network.
 * An API key would be a secret, and the client refuses one in a browser anyway (I07).
 */
export function readConfig(env: Env): WebConfig {
  const apiBaseUrl = env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
  const clientId = env.VITE_CLIENT_ID ?? "";
  if (clientId === "") throw new Error("VITE_CLIENT_ID is not set. Copy .env.example to .env.local.");
  return { apiBaseUrl, clientId, network: requireNetwork(env.VITE_NETWORK ?? "mainnet") };
}
