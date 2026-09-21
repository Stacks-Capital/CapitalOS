import { mulDiv } from "./amounts.ts";
import { capitalError } from "./errors.ts";
import { BPS, pow10 } from "./risk.ts";

export const DEFAULT_MAX_QUORUM_SPREAD_BPS = 300n; // 3.00% maximum disagreement spread
export const DEFAULT_PRICE_SCALE = 8;

export type ValuationStatus = "verified" | "disputed" | "stale" | "unsupported";

export type PriceReading = {
  source: string;
  price: bigint | string | null;
  scale: number;
  publishedAt: Date | string | null;
  observedAt: Date | string;
  stale: boolean;
  warnings?: string[];
};

export type AssetValuation = {
  assetId: string;
  price: string | null;
  scale: number;
  sourceSet: string[];
  timestamp: string;
  status: ValuationStatus;
  disagreement: boolean;
  spreadBps: number | null;
  warnings: string[];
};

export type QuorumOptions = {
  maxSpreadBps?: bigint;
  maxAgeMs?: number;
  now?: Date;
};

/**
 * Reconciles independent price source readings for an asset.
 * Guarantees every valuation carries asset ID, price, source set and timestamp.
 * If sources disagree beyond tolerance, fails closed by setting disagreement = true,
 * status = "disputed", and withholding a numeric price.
 */
export function reconcilePriceQuorum(
  assetId: string,
  readings: readonly PriceReading[],
  options: QuorumOptions = {},
): AssetValuation {
  const now = options.now ?? new Date();
  const maxSpreadBps = options.maxSpreadBps ?? DEFAULT_MAX_QUORUM_SPREAD_BPS;

  if (readings.length === 0) {
    return {
      assetId,
      price: null,
      scale: DEFAULT_PRICE_SCALE,
      sourceSet: [],
      timestamp: now.toISOString(),
      status: "unsupported",
      disagreement: false,
      spreadBps: null,
      warnings: [`Asset ${assetId} has no supported price oracle feed`],
    };
  }

  const sourceSet = [...new Set(readings.map((r) => r.source))];
  const allWarnings: string[] = [];
  for (const r of readings) {
    if (r.warnings) allWarnings.push(...r.warnings);
  }

  // Filter valid, non-stale readings with positive price
  const validReadings = readings.filter((r) => {
    if (r.stale) return false;
    if (r.price === null) return false;
    const val = typeof r.price === "string" ? BigInt(r.price) : r.price;
    return val > 0n;
  });

  if (validReadings.length === 0) {
    const firstReading = readings[0];
    const latestTimestamp = firstReading ? (firstReading.publishedAt ?? firstReading.observedAt) : now;
    return {
      assetId,
      price: null,
      scale: firstReading ? firstReading.scale : DEFAULT_PRICE_SCALE,
      sourceSet,
      timestamp:
        typeof latestTimestamp === "string"
          ? latestTimestamp
          : latestTimestamp instanceof Date
            ? latestTimestamp.toISOString()
            : now.toISOString(),
      status: "stale",
      disagreement: false,
      spreadBps: null,
      warnings: allWarnings.length > 0 ? allWarnings : [`Price readings for ${assetId} are stale or unavailable`],
    };
  }

  // Normalize prices to standard 8 decimals for comparison
  const normalized = validReadings.map((r) => {
    const raw = typeof r.price === "string" ? BigInt(r.price) : (r.price as bigint);
    const scaleDiff = BigInt(DEFAULT_PRICE_SCALE - r.scale);
    const scaled = scaleDiff >= 0n ? raw * pow10(scaleDiff) : raw / pow10(-scaleDiff);
    return { ...r, normalizedPrice: scaled, rawPrice: raw };
  });

  const firstNorm = normalized[0];
  let minPrice = firstNorm ? firstNorm.normalizedPrice : 0n;
  let maxPrice = firstNorm ? firstNorm.normalizedPrice : 0n;
  for (const item of normalized) {
    if (item.normalizedPrice < minPrice) minPrice = item.normalizedPrice;
    if (item.normalizedPrice > maxPrice) maxPrice = item.normalizedPrice;
  }

  const spreadBps = minPrice > 0n ? mulDiv(maxPrice - minPrice, BPS, minPrice, "up") : 0n;
  const latestPublished = validReadings
    .map((r) => r.publishedAt ?? r.observedAt)
    .sort()
    .reverse()[0];
  const timestampStr =
    typeof latestPublished === "string"
      ? latestPublished
      : latestPublished instanceof Date
        ? latestPublished.toISOString()
        : now.toISOString();

  // If multiple sources disagree beyond tolerance
  if (sourceSet.length > 1 && spreadBps > maxSpreadBps) {
    return {
      assetId,
      price: null, // Fail closed: withhold price during disagreement
      scale: DEFAULT_PRICE_SCALE,
      sourceSet,
      timestamp: timestampStr,
      status: "disputed",
      disagreement: true,
      spreadBps: Number(spreadBps),
      warnings: [
        ...allWarnings,
        `Quorum disagreement for ${assetId}: price sources disagree by ${spreadBps} bps (exceeds ${maxSpreadBps} bps limit)`,
      ],
    };
  }

  // Calculate median / agreed price
  const sorted = [...normalized].sort((a, b) => (a.normalizedPrice < b.normalizedPrice ? -1 : 1));
  const midItem = sorted[Math.floor(sorted.length / 2)];
  const medianPrice = midItem ? midItem.normalizedPrice : 0n;

  return {
    assetId,
    price: medianPrice.toString(10),
    scale: DEFAULT_PRICE_SCALE,
    sourceSet,
    timestamp: timestampStr,
    status: "verified",
    disagreement: false,
    spreadBps: sourceSet.length > 1 ? Number(spreadBps) : null,
    warnings: allWarnings,
  };
}

export type ValuedHoldingItem = {
  assetId: string;
  quantity: string | null;
  decimals: number;
  usdValue: string | null;
  status: "valued" | "unsupported" | "stale" | "disputed" | "missing_quantity";
  unvaluedReason: string | null;
  valuation: AssetValuation | null;
};

export type PortfolioCoverage = {
  isComplete: boolean;
  valuedCount: number;
  unvaluedCount: number;
  totalCount: number;
  coverageBps: number | null;
  valuedAssets: string[];
  unvaluedAssets: Array<{ assetId: string; reason: string; quantity: string | null }>;
};

export type PortfolioValuation = {
  totalUsd: string | null;
  coverage: PortfolioCoverage;
  items: ValuedHoldingItem[];
  warnings: string[];
};

function defaultDecimalsForAsset(assetId: string): number {
  if (assetId.includes(":stx") || assetId.toLowerCase().includes("usdc")) return 6;
  return 8;
}

/**
 * Values a set of asset holdings against oracle valuations.
 * Labels unsupported assets without withholding unrelated verified values.
 * Partial portfolio totals disclose valued and unvalued coverage.
 */
export function evaluatePortfolioValuation(
  holdings: ReadonlyArray<{ assetId: string; quantity: string | null; decimals?: number }>,
  valuations: ReadonlyMap<string, AssetValuation> | ReadonlyArray<AssetValuation>,
): PortfolioValuation {
  const valMap =
    valuations instanceof Map
      ? valuations
      : new Map((valuations as ReadonlyArray<AssetValuation>).map((v) => [v.assetId, v]));

  const items: ValuedHoldingItem[] = [];
  const valuedAssets: string[] = [];
  const unvaluedAssets: Array<{ assetId: string; reason: string; quantity: string | null }> = [];
  const warnings: string[] = [];
  let totalUsdBigInt = 0n;
  let hasAnyValued = false;

  for (const holding of holdings) {
    const decimals = holding.decimals ?? defaultDecimalsForAsset(holding.assetId);
    const valuation = valMap.get(holding.assetId) ?? null;

    if (holding.quantity === null) {
      items.push({
        assetId: holding.assetId,
        quantity: null,
        decimals,
        usdValue: null,
        status: "missing_quantity",
        unvaluedReason: "Holding quantity is unknown or missing",
        valuation,
      });
      unvaluedAssets.push({
        assetId: holding.assetId,
        reason: "Holding quantity is unknown or missing",
        quantity: null,
      });
      continue;
    }

    if (valuation === null || valuation.status === "unsupported") {
      items.push({
        assetId: holding.assetId,
        quantity: holding.quantity,
        decimals,
        usdValue: null,
        status: "unsupported",
        unvaluedReason: `Asset ${holding.assetId} has no supported price oracle feed`,
        valuation,
      });
      unvaluedAssets.push({
        assetId: holding.assetId,
        reason: `Asset ${holding.assetId} has no supported price oracle feed`,
        quantity: holding.quantity,
      });
      continue;
    }

    if (valuation.disagreement || valuation.status === "disputed") {
      items.push({
        assetId: holding.assetId,
        quantity: holding.quantity,
        decimals,
        usdValue: null,
        status: "disputed",
        unvaluedReason: `Quorum disagreement between price sources for ${holding.assetId}`,
        valuation,
      });
      unvaluedAssets.push({
        assetId: holding.assetId,
        reason: `Quorum disagreement between price sources for ${holding.assetId}`,
        quantity: holding.quantity,
      });
      warnings.push(`Quorum disagreement for ${holding.assetId}`);
      continue;
    }

    if (valuation.status === "stale" || valuation.price === null) {
      items.push({
        assetId: holding.assetId,
        quantity: holding.quantity,
        decimals,
        usdValue: null,
        status: "stale",
        unvaluedReason: `Price oracle reading for ${holding.assetId} is stale`,
        valuation,
      });
      unvaluedAssets.push({
        assetId: holding.assetId,
        reason: `Price oracle reading for ${holding.assetId} is stale`,
        quantity: holding.quantity,
      });
      continue;
    }

    // Verified valuation with quantity
    const qty = BigInt(holding.quantity);
    const price = BigInt(valuation.price);
    const notionalUsd = mulDiv(qty, price, pow10(BigInt(decimals)), "down");
    totalUsdBigInt += notionalUsd;
    hasAnyValued = true;
    valuedAssets.push(holding.assetId);

    items.push({
      assetId: holding.assetId,
      quantity: holding.quantity,
      decimals,
      usdValue: notionalUsd.toString(10),
      status: "valued",
      unvaluedReason: null,
      valuation,
    });
  }

  const totalCount = holdings.length;
  const valuedCount = valuedAssets.length;
  const unvaluedCount = unvaluedAssets.length;
  const isComplete = totalCount > 0 && unvaluedCount === 0;
  const coverageBps = totalCount > 0 ? Math.round((valuedCount / totalCount) * 10000) : null;

  return {
    totalUsd: hasAnyValued ? totalUsdBigInt.toString(10) : null,
    coverage: {
      isComplete,
      valuedCount,
      unvaluedCount,
      totalCount,
      coverageBps,
      valuedAssets,
      unvaluedAssets,
    },
    items,
    warnings,
  };
}

/**
 * Asserts that an oracle reading or valuation has no quorum disagreement.
 * Quorum disagreement fails closed for financial actions.
 */
export function assertOracleQuorum(
  oracle: { disagreement?: boolean; status?: string; warnings?: string[] },
  label: string,
): void {
  if (oracle.disagreement || oracle.status === "disputed") {
    throw capitalError("QUORUM_DISAGREEMENT", `${label} oracle has quorum disagreement; financial actions fail closed`);
  }
}
