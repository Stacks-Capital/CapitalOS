import { capitalError } from "@stacks-capital/core";
import { cvToJSON, hexToCV } from "@stacks/transactions";

export type HiroBlock = { height: number; hash: string; parentHash: string; blockTime: string };
export type HiroContractEvent = { txId: string; eventIndex: number; payloadHex: string; contractId: string };
/** A pending transaction has no block yet, so height and hash stay null until it lands. */
export type HiroTransaction = {
  status: string;
  blockHeight: number | null;
  blockHash: string | null;
  canonical: boolean;
};

export type HiroOptions = {
  apiBase: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type Hiro = ReturnType<typeof createHiro>;

type BlockPayload = { height: number; hash: string; parent_block_hash: string; block_time_iso: string };

function toBlock(payload: BlockPayload): HiroBlock {
  return {
    height: payload.height,
    hash: payload.hash,
    parentHash: payload.parent_block_hash,
    blockTime: payload.block_time_iso,
  };
}

export function createHiro(options: HiroOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  // The key stays on the server. Without it Hiro allows 20 requests a second, with it 40 (I01).
  const headers: Record<string, string> = options.apiKey ? { "x-api-key": options.apiKey } : {};

  async function get<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${options.apiBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) throw capitalError("PROVIDER_TIMEOUT", `${path} not found`);
    if (response.status === 429) throw capitalError("RATE_LIMITED", `${path} rate limited`);
    if (!response.ok) throw capitalError("PROVIDER_TIMEOUT", `${path} HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  return {
    async latestBlock(): Promise<HiroBlock> {
      const page = await get<{ results: BlockPayload[] }>("/extended/v2/blocks?limit=1");
      const [block] = page.results;
      if (block === undefined) throw capitalError("PROVIDER_TIMEOUT", "Hiro returned no blocks");
      return toBlock(block);
    },

    async blockAt(height: number): Promise<HiroBlock> {
      return toBlock(await get<BlockPayload>(`/extended/v2/blocks/${height}`));
    },

    async contractEvents(contractId: string, limit: number): Promise<HiroContractEvent[]> {
      const page = await get<{
        results: {
          tx_id: string;
          event_index: number;
          contract_log?: { contract_id: string; value: { hex: string } };
        }[];
      }>(`/extended/v1/contract/${contractId}/events?limit=${limit}`);
      return page.results.flatMap((event) =>
        event.contract_log === undefined
          ? []
          : [
              {
                txId: event.tx_id,
                eventIndex: event.event_index,
                payloadHex: event.contract_log.value.hex,
                contractId: event.contract_log.contract_id,
              },
            ],
      );
    },

    async transaction(txId: string): Promise<HiroTransaction> {
      const tx = await get<{
        tx_status?: string;
        block_height?: number | null;
        block_hash?: string | null;
        canonical?: boolean;
      }>(`/extended/v1/tx/${txId}`);
      // A mempool transaction reports no block. Zero is Hiro's placeholder for that, and treating it
      // as height zero would read as "older than every checkpoint", which is the opposite of the truth.
      const height = tx.block_height ?? null;
      return {
        status: tx.tx_status ?? "pending",
        blockHeight: height === null || height <= 0 ? null : height,
        blockHash: tx.block_hash ?? null,
        canonical: tx.canonical ?? false,
      };
    },

    async callRead(contractId: string, fn: string, args: string[], sender: string): Promise<string> {
      const [address, name] = contractId.split(".");
      if (address === undefined || name === undefined) throw new Error(`Bad contract id ${contractId}`);
      const response = await fetchImpl(`${options.apiBase}/v2/contracts/call-read/${address}/${name}/${fn}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ sender, arguments: args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await response.json()) as { okay?: boolean; result?: string; cause?: string };
      if (!response.ok || body.okay !== true || body.result === undefined) {
        throw capitalError("PROVIDER_TIMEOUT", `${contractId}.${fn} failed: ${body.cause ?? response.status}`);
      }
      return body.result;
    },
  };
}

type ClarityJson = { type: string; value: unknown; success?: boolean };

// Read-only results arrive as (ok value), (some value) or a bare value. Unwrapping keeps callers from repeating it.
function unwrap(json: ClarityJson): ClarityJson {
  let current = json;
  if (current.success === true) current = current.value as ClarityJson;
  if (current.type.startsWith("(optional")) {
    current = (current.value as ClarityJson | null) ?? { type: "none", value: null };
  }
  return current;
}

export function decodeUint(hex: string): bigint | null {
  const json = unwrap(cvToJSON(hexToCV(hex)) as ClarityJson);
  if (json.type === "uint" || json.type === "int") return BigInt(json.value as string);
  return null;
}

export function decodeTuple(hex: string): Record<string, ClarityJson> {
  const json = unwrap(cvToJSON(hexToCV(hex)) as ClarityJson);
  if (!json.type.startsWith("(tuple")) return {};
  return json.value as Record<string, ClarityJson>;
}

export function tupleUint(tuple: Record<string, ClarityJson>, key: string): bigint | null {
  const field = tuple[key];
  if (field === undefined || (field.type !== "uint" && field.type !== "int")) return null;
  return BigInt(field.value as string);
}

export function tupleBool(tuple: Record<string, ClarityJson>, key: string): boolean | null {
  const field = tuple[key];
  if (field === undefined || field.type !== "bool") return null;
  return field.value === true;
}

export function tupleString(tuple: Record<string, ClarityJson>, key: string): string | null {
  const field = tuple[key];
  if (field === undefined || !field.type.startsWith("(string")) return null;
  return String(field.value);
}

export function decodeUintList(hex: string): bigint[] {
  const json = unwrap(cvToJSON(hexToCV(hex)) as ClarityJson);
  if (!json.type.startsWith("(list")) return [];
  return (json.value as ClarityJson[]).map((entry) => BigInt(entry.value as string));
}
