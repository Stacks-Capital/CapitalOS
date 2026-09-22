import {
  type AssetValuation,
  type PortfolioCoverage,
  type ValuedHoldingItem,
  evaluatePortfolioValuation,
} from "./valuation.ts";

/**
 * The six canonical capital categories recognized across CapitalOS.
 */
export type CapitalCategory = "wallet" | "supplied" | "lp" | "collateral" | "debt" | "locked";

export const CAPITAL_CATEGORIES: readonly CapitalCategory[] = [
  "wallet",
  "supplied",
  "lp",
  "collateral",
  "debt",
  "locked",
] as const;

/**
 * Maps protocol or snapshot position kind strings to canonical capital categories.
 */
export function normalizeCapitalCategory(kind: string): CapitalCategory | null {
  const lower = kind.toLowerCase();
  if (lower === "wallet") return "wallet";
  if (lower === "supplied" || lower === "supply") return "supplied";
  if (lower === "lp" || lower === "liquidity" || lower === "pool") return "lp";
  if (lower === "collateral") return "collateral";
  if (lower === "debt" || lower === "borrow") return "debt";
  if (lower === "locked" || lower === "staked" || lower === "stake") return "locked";
  return null;
}

/**
 * Structural link tying a debt position to its backing collateral position.
 */
export type LinkedCollateralRef = {
  marketId: string;
  assetId: string;
  protocolKey?: string | undefined;
  quantity?: string | null | undefined;
};

/**
 * A single normalized accounting entry in the portfolio ledger.
 */
export type AccountingEntry = {
  id: string;
  category: CapitalCategory;
  assetId: string;
  quantity: string | null;
  marketId: string | null;
  protocolKey: string | null;
  /** True when this row is a receipt token for a protocol position. */
  isReceipt: boolean;
  /** False for receipts or uncounted duplicate claims so total never double-counts. */
  countsTowardTotal: boolean;
  /** Populated for debt rows to visibly link them to backing collateral. */
  linkedCollateral: LinkedCollateralRef | null;
  stale: boolean;
  warnings: string[];
};

export type CategoryAccountingSummary = {
  totalUsd: string | null;
  count: number;
  items: ValuedHoldingItem[];
};

export type PortfolioAccountingSummary = {
  /** Sum of all verified asset entries (wallet + supplied + lp + collateral + locked) in 10^-8 USD base units. */
  grossAssetsUsd: string | null;
  /** Sum of all verified debt obligations in 10^-8 USD base units. */
  grossDebtUsd: string | null;
  /** Net subtotal: grossAssetsUsd - grossDebtUsd (exact BigInt subtraction). */
  netWorthUsd: string | null;
  /** Aggregated portfolio coverage across all distinct assets. */
  coverage: PortfolioCoverage;
  /** Category breakdowns. */
  byCategory: Record<CapitalCategory, CategoryAccountingSummary>;
  /** True if any required asset or debt entry could not be fully valued. */
  incomplete: boolean;
  warnings: string[];
};

/**
 * Evaluates canonical portfolio accounting against price valuations.
 *
 * Enforces three core invariants:
 * 1. Normalized capital categories (wallet, supplied, lp, collateral, debt, locked).
 * 2. Receipt tokens are excluded from totals without discarding evidence.
 * 3. Exact net calculation: grossAssetsUsd - grossDebtUsd === netWorthUsd.
 */
export function evaluatePortfolioAccounting(
  entries: readonly AccountingEntry[],
  valuations: readonly AssetValuation[] | ReadonlyMap<string, AssetValuation>,
): PortfolioAccountingSummary {
  const warnings: string[] = [];
  let incomplete = false;

  // 1. Separate entries by category and filter for counting
  const assetHoldings: { assetId: string; quantity: string | null }[] = [];
  const debtHoldings: { assetId: string; quantity: string | null }[] = [];

  const byCategoryMap: Record<CapitalCategory, { assetId: string; quantity: string | null }[]> = {
    wallet: [],
    supplied: [],
    lp: [],
    collateral: [],
    debt: [],
    locked: [],
  };

  for (const entry of entries) {
    if (!entry.countsTowardTotal) {
      if (entry.isReceipt) {
        warnings.push(`Receipt ${entry.assetId} is held as evidence; not double-counted.`);
      }
      continue;
    }

    if (entry.quantity === null) {
      incomplete = true;
      warnings.push(`Entry ${entry.id} (${entry.assetId}) has null quantity; zero is not assumed.`);
    }

    byCategoryMap[entry.category].push({ assetId: entry.assetId, quantity: entry.quantity });

    if (entry.category === "debt") {
      debtHoldings.push({ assetId: entry.assetId, quantity: entry.quantity });
    } else {
      assetHoldings.push({ assetId: entry.assetId, quantity: entry.quantity });
    }
  }

  // Aggregate quantities by asset for valuation
  function aggregateHoldings(list: { assetId: string; quantity: string | null }[]) {
    const map = new Map<string, string | null>();
    for (const h of list) {
      const current = map.get(h.assetId);
      if (current === null || h.quantity === null) {
        map.set(h.assetId, null);
      } else {
        const prev = current === undefined ? 0n : BigInt(current);
        map.set(h.assetId, (prev + BigInt(h.quantity)).toString(10));
      }
    }
    return [...map.entries()].map(([assetId, quantity]) => ({ assetId, quantity }));
  }

  const aggregatedAssets = aggregateHoldings(assetHoldings);
  const aggregatedDebts = aggregateHoldings(debtHoldings);

  // 2. Value assets and debts independently
  const assetValuation = evaluatePortfolioValuation(aggregatedAssets, valuations);
  const debtValuation = evaluatePortfolioValuation(aggregatedDebts, valuations);

  // Value each category
  const byCategory: Record<CapitalCategory, CategoryAccountingSummary> = {
    wallet: { totalUsd: "0", count: 0, items: [] },
    supplied: { totalUsd: "0", count: 0, items: [] },
    lp: { totalUsd: "0", count: 0, items: [] },
    collateral: { totalUsd: "0", count: 0, items: [] },
    debt: { totalUsd: "0", count: 0, items: [] },
    locked: { totalUsd: "0", count: 0, items: [] },
  };

  for (const cat of CAPITAL_CATEGORIES) {
    const catAgg = aggregateHoldings(byCategoryMap[cat]);
    const catVal = evaluatePortfolioValuation(catAgg, valuations);
    byCategory[cat] = {
      totalUsd: catVal.totalUsd,
      count: byCategoryMap[cat].length,
      items: catVal.items,
    };
  }

  const grossAssetsUsd = aggregatedAssets.length === 0 ? "0" : assetValuation.totalUsd;
  const grossDebtUsd = aggregatedDebts.length === 0 ? "0" : debtValuation.totalUsd;

  // 3. Exact Net Subtotal: grossAssetsUsd - grossDebtUsd
  let netWorthUsd: string | null = null;
  if (grossAssetsUsd !== null && grossDebtUsd !== null) {
    const net = BigInt(grossAssetsUsd) - BigInt(grossDebtUsd);
    netWorthUsd = net.toString(10);
  } else {
    incomplete = true;
  }

  // 4. Combined Coverage across all unique evaluated assets
  const allAssetIds = new Set([...aggregatedAssets.map((a) => a.assetId), ...aggregatedDebts.map((d) => d.assetId)]);
  const valuedSet = new Set([...assetValuation.coverage.valuedAssets, ...debtValuation.coverage.valuedAssets]);
  const unvaluedMap = new Map<string, { reason: string; quantity: string | null }>();
  for (const u of [...assetValuation.coverage.unvaluedAssets, ...debtValuation.coverage.unvaluedAssets]) {
    unvaluedMap.set(u.assetId, { reason: u.reason, quantity: u.quantity });
  }

  const totalCount = allAssetIds.size;
  const valuedCount = valuedSet.size;
  const unvaluedCount = unvaluedMap.size;
  const coverageBps = totalCount === 0 ? 10000 : Math.round((valuedCount * 10000) / totalCount);
  const isComplete = totalCount > 0 && valuedCount === totalCount && !incomplete;

  const coverage: PortfolioCoverage = {
    isComplete,
    valuedCount,
    unvaluedCount,
    totalCount,
    coverageBps,
    valuedAssets: [...valuedSet],
    unvaluedAssets: [...unvaluedMap.entries()].map(([assetId, info]) => ({
      assetId,
      reason: info.reason,
      quantity: info.quantity,
    })),
  };

  return {
    grossAssetsUsd,
    grossDebtUsd,
    netWorthUsd,
    coverage,
    byCategory,
    incomplete: !isComplete,
    warnings: [
      ...warnings,
      ...assetValuation.warnings,
      ...debtValuation.warnings,
      ...coverage.unvaluedAssets.map((u) => `Asset ${u.assetId} could not be valued: ${u.reason}`),
    ],
  };
}
