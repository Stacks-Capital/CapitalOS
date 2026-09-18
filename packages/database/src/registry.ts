import type { Sql } from "./lib.ts";

export type NetworkName = "mainnet" | "testnet";
// Same values as the capability_state domain in 0001_registry.sql.
export type CapabilityState = "enabled" | "read_only" | "paused" | "disabled";

export type CapabilityRecord = {
  marketId: string;
  action: string;
  state: CapabilityState;
  reason: string;
  contractId: string;
  deploymentId: string | null;
  adapterVersion: string;
  registryVersion: string;
};

export type MarketRecord = {
  id: string;
  network: NetworkName;
  protocol: string;
  suppliedAssetId: string | null;
  receiptAssetId: string | null;
  capabilities: Omit<CapabilityRecord, "marketId">[];
};

export type Page<T> = { items: T[]; hasMore: boolean };

// Keyset pagination: rows after the last key, plus one extra row to learn whether another page exists.
function page<T>(rows: T[], limit: number): Page<T> {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function listMarkets(
  sql: Sql,
  input: { network: NetworkName; afterId: string | null; limit: number },
): Promise<Page<MarketRecord>> {
  const rows = await sql<MarketRecord[]>`
    SELECT m.id,
           m.network,
           m.protocol_id AS protocol,
           m.supplied_asset_id AS "suppliedAssetId",
           m.receipt_asset_id AS "receiptAssetId",
           coalesce(
             json_agg(
               json_build_object(
                 'action', c.action,
                 'state', c.state,
                 'reason', c.reason,
                 'contractId', c.contract_id,
                 'deploymentId', c.deployment_id,
                 'adapterVersion', c.adapter_version,
                 'registryVersion', c.registry_version
               ) ORDER BY c.action
             ) FILTER (WHERE c.action IS NOT NULL),
             '[]'
           ) AS capabilities
    FROM markets m
    LEFT JOIN effective_capabilities c ON c.network = m.network AND c.market_id = m.id
    WHERE m.network = ${input.network}
      AND (${input.afterId}::text IS NULL OR m.id > ${input.afterId}::text)
    GROUP BY m.network, m.id
    ORDER BY m.id
    LIMIT ${input.limit + 1}
  `;
  return page(rows, input.limit);
}

export async function listCapabilities(
  sql: Sql,
  input: { network: NetworkName; after: { marketId: string; action: string } | null; limit: number },
): Promise<Page<CapabilityRecord>> {
  const afterMarket = input.after?.marketId ?? null;
  const afterAction = input.after?.action ?? null;
  const rows = await sql<CapabilityRecord[]>`
    SELECT market_id AS "marketId",
           action,
           state,
           reason,
           contract_id AS "contractId",
           deployment_id AS "deploymentId",
           adapter_version AS "adapterVersion",
           registry_version AS "registryVersion"
    FROM effective_capabilities
    WHERE network = ${input.network}
      AND (${afterMarket}::text IS NULL OR (market_id, action::text) > (${afterMarket}::text, ${afterAction}::text))
    ORDER BY market_id, action
    LIMIT ${input.limit + 1}
  `;
  return page(rows, input.limit);
}
