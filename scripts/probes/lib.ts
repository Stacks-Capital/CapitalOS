export type Network = "testnet" | "mainnet";

const NETWORKS: readonly Network[] = ["testnet", "mainnet"];

export function parseNetworks(value: string | undefined): Network[] {
  if (value === undefined || value === "") {
    throw new Error("Pass --network testnet, mainnet or both. There is no default network.");
  }
  if (value === "both") return [...NETWORKS];
  const match = NETWORKS.find((network) => network === value);
  if (match === undefined) throw new Error(`Unknown network "${value}". Use testnet, mainnet or both.`);
  return [match];
}

const BITCOIN_GENESIS: Readonly<Record<string, string>> = {
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f": "mainnet",
  "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943": "testnet3",
  "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043": "testnet4",
  "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6": "signet",
  "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206": "regtest",
};

// Every regtest chain shares one genesis hash, so a match proves the network type, not the exact chain.
export function identifyBitcoinNetwork(genesisHash: string): string {
  return BITCOIN_GENESIS[genesisHash.trim().toLowerCase()] ?? "unknown";
}

export function pickRateLimitHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (/^(x-)?ratelimit|^retry-after$/i.test(name)) picked[name.toLowerCase()] = value;
  });
  return picked;
}

export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  return secrets.reduce<string>((out, secret) => (secret ? out.split(secret).join("[redacted]") : out), text);
}
