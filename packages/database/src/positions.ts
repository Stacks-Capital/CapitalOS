import type { Provenance } from "./ingestion.ts";
import type { Sql } from "./lib.ts";
import type { NetworkName } from "./registry.ts";

export type PositionKind =
  | "wallet"
  | "supplied"
  | "debt"
  | "collateral"
  | "pending_deposit"
  | "pending_withdrawal"
  | "staked";

export type PositionSnapshotRow = Provenance & {
  owner: string;
  network: NetworkName;
  deploymentId: string;
  marketId: string;
  kind: PositionKind;
  /** The protocol's own name for this position, so two positions in one market stay distinct. */
  protocolKey: string;
  assetId: string;
  quantity: string | null;
  adapterVersion: string;
  calculationVersion: string;
};

export type RewardSnapshotRow = Provenance & {
  network: NetworkName;
  marketId: string;
  owner: string | null;
  kind: "rate" | "accrual";
  rate: string | null;
  rateScale: number | null;
  accrued: string | null;
  accruedAssetId: string | null;
  updatedAt: Date | null;
  adapterVersion: string;
  calculationVersion: string;
};

export type MarketAssets = {
  marketId: string;
  deploymentId: string;
  suppliedAssetId: string | null;
  receiptAssetId: string | null;
  adapterVersion: string;
};

/** What each market supplies and hands back, so a decoded position can name real assets. */
export async function listMarketAssets(sql: Sql, network: NetworkName): Promise<MarketAssets[]> {
  return sql<MarketAssets[]>`
    SELECT DISTINCT ON (m.id)
           m.id AS "marketId", c.deployment_id AS "deploymentId", m.supplied_asset_id AS "suppliedAssetId",
           m.receipt_asset_id AS "receiptAssetId", c.adapter_version AS "adapterVersion"
    FROM markets m
    JOIN capabilities c ON c.network = m.network AND c.market_id = m.id AND c.state <> 'disabled'
    WHERE m.network = ${network}
    ORDER BY m.id, c.action
  `;
}

/** Addresses the platform already knows: anyone who started a workflow. */
export async function listKnownOwners(sql: Sql, network: NetworkName): Promise<string[]> {
  const rows = await sql<{ owner: string }[]>`
    SELECT DISTINCT owner_address AS owner
    FROM workflows
    WHERE network = ${network} AND owner_address IS NOT NULL
    ORDER BY owner_address
  `;
  return rows.map((row) => row.owner);
}

export async function insertPositionSnapshot(sql: Sql, row: PositionSnapshotRow): Promise<boolean> {
  const result = await sql`
    INSERT INTO position_snapshots (owner, network, deployment_id, market_id, kind, protocol_key, asset_id, quantity,
                                    stale, warnings, source, observed_at, block_height, block_hash, adapter_version,
                                    calculation_version)
    VALUES (${row.owner}, ${row.network}, ${row.deploymentId}, ${row.marketId}, ${row.kind}, ${row.protocolKey},
            ${row.assetId}, ${row.quantity}, ${row.stale}, ${sql.array(row.warnings)}, ${row.source}, ${row.observedAt},
            ${row.blockHeight}, ${row.blockHash}, ${row.adapterVersion}, ${row.calculationVersion})
    ON CONFLICT DO NOTHING
  `;
  return result.count > 0;
}

export async function insertRewardSnapshot(sql: Sql, row: RewardSnapshotRow): Promise<boolean> {
  const result = await sql`
    INSERT INTO reward_snapshots (network, market_id, owner, kind, rate, rate_scale, accrued, accrued_asset_id,
                                  updated_at, stale, warnings, source, observed_at, block_height, block_hash,
                                  adapter_version, calculation_version)
    VALUES (${row.network}, ${row.marketId}, ${row.owner}, ${row.kind}, ${row.rate}, ${row.rateScale}, ${row.accrued},
            ${row.accruedAssetId}, ${row.updatedAt}, ${row.stale}, ${sql.array(row.warnings)}, ${row.source},
            ${row.observedAt}, ${row.blockHeight}, ${row.blockHash}, ${row.adapterVersion}, ${row.calculationVersion})
    ON CONFLICT DO NOTHING
  `;
  return result.count > 0;
}

export type OwnerPosition = PositionSnapshotRow & { rewardRate: string | null; rewardScale: number | null };

/** The latest snapshot per position for one address, with the market's reward rate beside it. */
export async function latestPositions(
  sql: Sql,
  input: { network: NetworkName; owner: string },
): Promise<OwnerPosition[]> {
  return sql<OwnerPosition[]>`
    SELECT DISTINCT ON (p.market_id, p.kind, p.protocol_key, p.asset_id)
           p.owner, p.network, p.deployment_id AS "deploymentId", p.market_id AS "marketId", p.kind,
           p.protocol_key AS "protocolKey", p.asset_id AS "assetId", p.quantity::text AS quantity, p.stale, p.warnings,
           p.source, p.observed_at AS "observedAt", p.block_height::int AS "blockHeight", p.block_hash AS "blockHash",
           p.adapter_version AS "adapterVersion", p.calculation_version AS "calculationVersion",
           r.rate::text AS "rewardRate", r.rate_scale::int AS "rewardScale"
    FROM position_snapshots p
    LEFT JOIN LATERAL (
      SELECT rate, rate_scale FROM reward_snapshots
      WHERE network = p.network AND market_id = p.market_id AND kind = 'rate'
      ORDER BY observed_at DESC LIMIT 1
    ) r ON true
    WHERE p.network = ${input.network} AND p.owner = ${input.owner}
    ORDER BY p.market_id, p.kind, p.protocol_key, p.asset_id, p.observed_at DESC
  `;
}
