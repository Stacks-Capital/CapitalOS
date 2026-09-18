export type EmbedConfig = { apiBaseUrl: string; clientId: string; network: "mainnet" | "testnet" };

type Env = Record<string, string | undefined>;

/**
 * Everything read here ends up in the browser bundle, so it must all be publishable.
 * A value shaped like an API key or a session token is refused before the page even starts,
 * because a secret in a bundle is readable by anyone who opens the page.
 */
export function readEmbedConfig(env: Env): EmbedConfig {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("VITE_") || value === undefined) continue;
    if (/^(key|ses)_[a-f0-9]{16}\./.test(value)) {
      throw new Error(`${name} holds a secret. API keys and session tokens never belong in browser code.`);
    }
  }

  const clientId = env.VITE_CLIENT_ID ?? "";
  if (!/^pk_[a-z0-9_]+$/.test(clientId)) {
    throw new Error("VITE_CLIENT_ID must be a publishable client id, which starts with pk_.");
  }
  const network = env.VITE_NETWORK ?? "mainnet";
  if (network !== "mainnet" && network !== "testnet") throw new Error("VITE_NETWORK must be mainnet or testnet.");

  return { apiBaseUrl: env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000", clientId, network };
}
