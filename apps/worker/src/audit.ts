import {
  type ChainName,
  type CheckpointRow,
  type NetworkName,
  type Sql,
  getMissingSnapshotTargets,
  listAllCheckpoints,
  listProjectionTargets,
  readCheckpoint,
} from "@stacks-capital/database";
import { PROJECTION_SOURCE } from "./markets.ts";

export const REQUIRED_PRICE_FEEDS = ["BTC/USD", "STX/USD", "sBTC/USD"] as const;

export type TargetAuditStatus = {
  marketId: string;
  protocol: string;
  contractId: string;
  role: string;
  hasSnapshot: boolean;
  stale: boolean;
  availableLiquidity: string | null;
  warnings: string[];
  observedAt: string | null;
  blockHeight: number | null;
};

export type PriceFeedAuditStatus = {
  feedKey: string;
  hasSnapshot: boolean;
  price: string | null;
  stale: boolean;
  warnings: string[];
  publishedAt: string | null;
  observedAt: string | null;
};

export type ProjectionAuditReport = {
  at: string;
  network: NetworkName;
  chain: ChainName;
  checkpoint: CheckpointRow | null;
  allCheckpoints: { chain: ChainName; network: NetworkName; height: number; hash: string }[];
  isHealthy: boolean;
  targetsAudited: number;
  missingTargets: string[];
  staleTargets: string[];
  targetStatuses: TargetAuditStatus[];
  priceFeedsAudited: number;
  missingPriceFeeds: string[];
  priceFeedStatuses: PriceFeedAuditStatus[];
  reconciliation: {
    total: number;
    match: number;
    mismatch: number;
    unavailable: number;
  };
  auditErrors: string[];
};

/**
 * Audits whether all active projection targets have fresh/valid snapshots,
 * whether checkpoints are intact and advance, and whether any gaps exist.
 */
export async function auditProjections(deps: {
  sql: Sql;
  network: NetworkName;
  chain?: ChainName;
  source?: string;
  priceFeeds?: readonly string[];
}): Promise<ProjectionAuditReport> {
  const chain = deps.chain ?? "stacks";
  const source = deps.source ?? PROJECTION_SOURCE;
  const feeds = deps.priceFeeds ?? REQUIRED_PRICE_FEEDS;
  const auditErrors: string[] = [];

  const checkpoint = await readCheckpoint(deps.sql, chain, deps.network);
  if (checkpoint === null) {
    auditErrors.push(`No checkpoint found for ${chain}:${deps.network}`);
  }

  const allCheckpoints = await listAllCheckpoints(deps.sql);
  const targets = await listProjectionTargets(deps.sql, deps.network);
  const missingTargets = await getMissingSnapshotTargets(deps.sql, deps.network, source);
  if (missingTargets.length > 0) {
    auditErrors.push(`Targets missing canonical snapshots (${source}): ${missingTargets.join(", ")}`);
  }

  const targetStatuses: TargetAuditStatus[] = [];
  const staleTargets: string[] = [];

  for (const target of targets) {
    const [snapshot] = await deps.sql<
      {
        availableLiquidity: string | null;
        stale: boolean;
        warnings: string[];
        observedAt: Date;
        blockHeight: number | null;
      }[]
    >`
      SELECT available_liquidity::text AS "availableLiquidity", stale, warnings,
             observed_at AS "observedAt", block_height::int AS "blockHeight"
      FROM market_snapshots
      WHERE network = ${deps.network} AND market_id = ${target.marketId} AND source = ${source}
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `;

    if (!snapshot) {
      targetStatuses.push({
        marketId: target.marketId,
        protocol: target.protocol,
        contractId: target.contractId,
        role: target.role,
        hasSnapshot: false,
        stale: true,
        availableLiquidity: null,
        warnings: ["Missing snapshot"],
        observedAt: null,
        blockHeight: null,
      });
    } else {
      if (snapshot.stale) {
        staleTargets.push(target.marketId);
      }
      targetStatuses.push({
        marketId: target.marketId,
        protocol: target.protocol,
        contractId: target.contractId,
        role: target.role,
        hasSnapshot: true,
        stale: snapshot.stale,
        availableLiquidity: snapshot.availableLiquidity,
        warnings: snapshot.warnings,
        observedAt: snapshot.observedAt.toISOString(),
        blockHeight: snapshot.blockHeight,
      });
    }
  }

  // Price feeds audit
  const priceFeedStatuses: PriceFeedAuditStatus[] = [];
  const missingPriceFeeds: string[] = [];

  for (const feedKey of feeds) {
    const [priceRow] = await deps.sql<
      {
        price: string | null;
        stale: boolean;
        warnings: string[];
        publishedAt: Date | null;
        observedAt: Date;
      }[]
    >`
      SELECT price::text, stale, warnings, published_at AS "publishedAt", observed_at AS "observedAt"
      FROM price_snapshots
      WHERE network = ${deps.network} AND feed_key = ${feedKey}
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `;

    if (!priceRow) {
      missingPriceFeeds.push(feedKey);
      priceFeedStatuses.push({
        feedKey,
        hasSnapshot: false,
        price: null,
        stale: true,
        warnings: ["Missing price snapshot"],
        publishedAt: null,
        observedAt: null,
      });
      auditErrors.push(`Missing oracle feed snapshot for ${feedKey}`);
    } else {
      priceFeedStatuses.push({
        feedKey,
        hasSnapshot: true,
        price: priceRow.price,
        stale: priceRow.stale,
        warnings: priceRow.warnings,
        publishedAt: priceRow.publishedAt?.toISOString() ?? null,
        observedAt: priceRow.observedAt.toISOString(),
      });
    }
  }

  // Reconciliation summary
  const [reconSummary] = await deps.sql<{ total: number; matches: number; mismatches: number; unavailables: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'match')::int AS matches,
           count(*) FILTER (WHERE status = 'mismatch')::int AS mismatches,
           count(*) FILTER (WHERE status = 'unavailable')::int AS unavailables
    FROM reconciliation_runs
    WHERE network = ${deps.network}
  `;

  const reconciliation = {
    total: reconSummary?.total ?? 0,
    match: reconSummary?.matches ?? 0,
    mismatch: reconSummary?.mismatches ?? 0,
    unavailable: reconSummary?.unavailables ?? 0,
  };

  const isHealthy = checkpoint !== null && missingTargets.length === 0 && missingPriceFeeds.length === 0;

  return {
    at: new Date().toISOString(),
    network: deps.network,
    chain,
    checkpoint,
    allCheckpoints,
    isHealthy,
    targetsAudited: targets.length,
    missingTargets,
    staleTargets,
    targetStatuses,
    priceFeedsAudited: feeds.length,
    missingPriceFeeds,
    priceFeedStatuses,
    reconciliation,
    auditErrors,
  };
}
