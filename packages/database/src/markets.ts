import type { Sql } from "./lib.ts";
import type { NetworkName } from "./registry.ts";

export type MarketObservation = {
  source: string;
  sourceType: "independent" | "provider_reported";
  isIndependentRead: boolean;
  availableLiquidity: string | null;
  capacity: string | null;
  supplyRate: string | null;
  borrowRate: string | null;
  rateScale: number | null;
  paused: boolean | null;
  stale: boolean;
  warnings: string[];
  observedAt: Date;
  blockHeight: number | null;
  blockHash: string | null;
};

export type MarketEvidenceRecord = {
  marketId: string;
  network: NetworkName;
  protocol: string;
  source: string;
  blockHeight: number | null;
  blockHash: string | null;
  observedAt: Date | null;
  evidenceAgeSeconds: number | null;
  confidence: "high" | "medium" | "low";
  disagreement: "match" | "mismatch" | "unavailable" | null;
  disagreementDetail: string | null;
  isIndependentRead: boolean;
  rate: {
    supplyRate: string | null;
    borrowRate: string | null;
    rateScale: number | null;
    stale: boolean;
  };
  liquidity: {
    available: string | null;
    capacity: string | null;
    stale: boolean;
  };
  warnings: string[];
  observations: MarketObservation[];
};

/**
 * Retrieves full source-tagged evidence for a market, contrasting independent contract reads
 * with provider-reported observations and exposing reconciliation disagreement and confidence.
 */
export async function getMarketEvidence(
  sql: Sql,
  network: NetworkName,
  marketId: string,
  now = new Date(),
): Promise<MarketEvidenceRecord | null> {
  const [market] = await sql<{ id: string; protocol: string }[]>`
    SELECT id, protocol_id AS protocol FROM markets WHERE network = ${network} AND id = ${marketId}
  `;
  if (!market) return null;

  // Query distinct observations across all recorded sources for this market
  const observationRows = await sql<
    {
      source: string;
      availableLiquidity: string | null;
      capacity: string | null;
      supplyRate: string | null;
      borrowRate: string | null;
      rateScale: number | null;
      paused: boolean | null;
      stale: boolean;
      warnings: string[];
      observedAt: Date;
      blockHeight: number | null;
      blockHash: string | null;
    }[]
  >`
    SELECT DISTINCT ON (source)
           source,
           available_liquidity::text AS "availableLiquidity",
           capacity::text AS capacity,
           supply_rate::text AS "supplyRate",
           borrow_rate::text AS "borrowRate",
           rate_scale::int AS "rateScale",
           paused,
           stale,
           warnings,
           observed_at AS "observedAt",
           block_height::int AS "blockHeight",
           block_hash AS "blockHash"
    FROM market_snapshots
    WHERE network = ${network} AND market_id = ${marketId}
    ORDER BY source, observed_at DESC, id DESC
  `;

  // Latest reconciliation run
  const [recon] = await sql<{ status: "match" | "mismatch" | "unavailable"; detail: string }[]>`
    SELECT status, detail FROM reconciliation_runs
    WHERE network = ${network} AND market_id = ${marketId}
    ORDER BY run_at DESC, id DESC
    LIMIT 1
  `;

  const observations: MarketObservation[] = observationRows.map((obs) => ({
    ...obs,
    sourceType: obs.source === "hiro-read" ? "independent" : "provider_reported",
    isIndependentRead: obs.source === "hiro-read",
  }));

  // Canonical independent snapshot (prefer hiro-read)
  const canonical = observations.find((o) => o.source === "hiro-read") ?? observations[0];

  const observedAt = canonical?.observedAt ?? null;
  const evidenceAgeSeconds = observedAt ? Math.max(0, Math.round((now.getTime() - observedAt.getTime()) / 1000)) : null;

  const isStale = canonical?.stale ?? true;
  const warnings = canonical?.warnings ?? (canonical ? [] : ["No market snapshot recorded"]);

  let confidence: "high" | "medium" | "low" = "high";
  if (isStale || recon?.status === "mismatch") {
    confidence = "low";
  } else if (warnings.length > 0 || recon?.status === "unavailable" || !canonical) {
    confidence = "medium";
  }

  return {
    marketId: market.id,
    network,
    protocol: market.protocol,
    source: canonical?.source ?? "unknown",
    blockHeight: canonical?.blockHeight ?? null,
    blockHash: canonical?.blockHash ?? null,
    observedAt,
    evidenceAgeSeconds,
    confidence,
    disagreement: recon?.status ?? null,
    disagreementDetail: recon?.detail ?? null,
    isIndependentRead: canonical?.source === "hiro-read",
    rate: {
      supplyRate: canonical?.supplyRate ?? null,
      borrowRate: canonical?.borrowRate ?? null,
      rateScale: canonical?.rateScale ?? null,
      stale: isStale,
    },
    liquidity: {
      available: canonical?.availableLiquidity ?? null,
      capacity: canonical?.capacity ?? null,
      stale: isStale,
    },
    warnings,
    observations,
  };
}
