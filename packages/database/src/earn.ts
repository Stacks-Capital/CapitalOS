import type { Sql } from "./lib.ts";
import type { NetworkName } from "./registry.ts";

/** Everything a caller needs to compare one earn option, as facts with their provenance. */
export type EarnOptionRow = {
  marketId: string;
  protocol: string;
  suppliedAssetId: string | null;
  receiptAssetId: string | null;
  supplyState: string;
  supplyReason: string;
  /** Withdrawal is a condition of the strategy, not an afterthought: it may be disabled or paused. */
  withdrawState: string | null;
  withdrawReason: string | null;
  baseRate: string | null;
  baseRateScale: number | null;
  incentiveRate: string | null;
  incentiveRateScale: number | null;
  availableLiquidity: string | null;
  capacity: string | null;
  paused: boolean | null;
  stale: boolean;
  warnings: string[];
  observedAt: Date | null;
  adapterVersion: string;
  blockHeight: number | null;
  blockHash: string | null;
  source: string;
  disagreement: "match" | "mismatch" | "unavailable" | null;
  disagreementDetail: string | null;
  confidence: "high" | "medium" | "low";
  isIndependentRead: boolean;
};

/**
 * One row per market that can be supplied into, with its latest projection and reward rate.
 * Missing values stay null: a market with no snapshot is not the same as a market paying nothing.
 */
export async function listEarnOptions(sql: Sql, network: NetworkName): Promise<EarnOptionRow[]> {
  return sql<EarnOptionRow[]>`
    SELECT m.id AS "marketId",
           m.protocol_id AS protocol,
           m.supplied_asset_id AS "suppliedAssetId",
           m.receipt_asset_id AS "receiptAssetId",
           supply.state AS "supplyState",
           supply.reason AS "supplyReason",
           withdraw.state AS "withdrawState",
           withdraw.reason AS "withdrawReason",
           snapshot.supply_rate::text AS "baseRate",
           snapshot.rate_scale::int AS "baseRateScale",
           reward.rate::text AS "incentiveRate",
           reward.rate_scale::int AS "incentiveRateScale",
           snapshot.available_liquidity::text AS "availableLiquidity",
           snapshot.capacity::text AS capacity,
           snapshot.paused,
           coalesce(snapshot.stale, true) AS stale,
           coalesce(snapshot.warnings, '{}') || coalesce(reward.warnings, '{}') AS warnings,
           snapshot.observed_at AS "observedAt",
           supply.adapter_version AS "adapterVersion",
           snapshot.block_height::int AS "blockHeight",
           snapshot.block_hash AS "blockHash",
           coalesce(snapshot.source, 'hiro-read') AS source,
           recon.status::text AS disagreement,
           recon.detail AS "disagreementDetail",
           CASE
             WHEN coalesce(snapshot.stale, true) OR recon.status = 'mismatch' THEN 'low'
             WHEN cardinality(coalesce(snapshot.warnings, '{}') || coalesce(reward.warnings, '{}')) > 0 OR recon.status = 'unavailable' THEN 'medium'
             ELSE 'high'
           END AS confidence,
           coalesce(snapshot.source = 'hiro-read', false) AS "isIndependentRead"
    FROM markets m
    JOIN effective_capabilities supply
      ON supply.network = m.network AND supply.market_id = m.id AND supply.action = 'supply'
    LEFT JOIN effective_capabilities withdraw
      ON withdraw.network = m.network AND withdraw.market_id = m.id AND withdraw.action = 'withdraw_supply'
    LEFT JOIN LATERAL (
      SELECT supply_rate, rate_scale, available_liquidity, capacity, paused, stale, warnings, observed_at,
             block_height, block_hash, source
      FROM market_snapshots
      WHERE network = m.network AND market_id = m.id AND source = 'hiro-read'
      ORDER BY observed_at DESC, id DESC LIMIT 1
    ) snapshot ON true
    LEFT JOIN LATERAL (
      SELECT rate, rate_scale, warnings
      FROM reward_snapshots
      WHERE network = m.network AND market_id = m.id AND kind = 'rate'
      ORDER BY observed_at DESC, id DESC LIMIT 1
    ) reward ON true
    LEFT JOIN LATERAL (
      SELECT status, detail
      FROM reconciliation_runs
      WHERE network = m.network AND market_id = m.id
      ORDER BY run_at DESC, id DESC LIMIT 1
    ) recon ON true
    WHERE m.network = ${network}
    ORDER BY m.id
  `;
}
