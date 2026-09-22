import { mulDiv, parseQuantity } from "./amounts.ts";

export type CashFlowKind = "deposit" | "withdrawal" | "fee" | "reward_claim";

export type CashFlowEvent = {
  id: string;
  kind: CashFlowKind;
  assetId: string;
  amount: string;
  timestamp: string;
  blockHeight?: number | null;
  blockHash?: string | null;
  txid?: string | null;
};

export type ShareRate = {
  numerator: string;
  denominator: string;
};

export type CashFlowAttribution = {
  depositsTotal: string;
  withdrawalsTotal: string;
  netDeposits: string;
  feesTotal: string;
  claimedRewardsTotal: string;
  costBasis: string;
  currentValue: string;
  unattributedInflow: string;
  hasUnattributedInflow: boolean;
  earnedYield: string;
  warnings: string[];
};

export type RealizedEarnings = {
  amount: string;
  usdValue: string | null;
  assetId: string;
};

export type UnclaimedReward = {
  assetId: string;
  amount: string;
  usdValue: string | null;
  observedAt: string;
};

export type AccruedEstimate = {
  amount: string;
  usdValue: string | null;
  assetId: string;
  shareAppreciationAmount: string;
  unclaimedRewards: UnclaimedReward[];
};

export type ProjectionRateStatus = "verified" | "unverified" | "stale" | "disputed" | "missing";

export type Forward30dProjection = {
  isProjectionAvailable: boolean;
  projected30dAmount: string | null;
  projected30dUsd: string | null;
  rateUsedBps: string | null;
  rateStatus: ProjectionRateStatus;
  unavailableReason: string | null;
};

export type CanonicalObservation = {
  observedAt: string;
  blockHeight: number | null;
  blockHash: string | null;
  source: string;
  shareRate?: ShareRate | null;
  positionShares?: string | null;
  underlyingValue?: string | null;
  accruedRewards?: string | null;
};

export type CanonicalPerformancePoint = {
  timestamp: string;
  blockHeight: number | null;
  blockHash: string | null;
  source: string;
  shareRate: ShareRate | null;
  positionShares: string | null;
  underlyingValue: string;
  cumulativeYield: string;
};

export type PerformanceChartSeries = {
  hasChart: boolean;
  points: CanonicalPerformancePoint[];
  observationCount: number;
  reason: string | null;
};

export type EarnedPerformanceBreakdown = {
  marketId: string;
  assetId: string;
  attribution: CashFlowAttribution;
  realizedEarnings: RealizedEarnings;
  accruedEstimate: AccruedEstimate;
  forward30dProjection: Forward30dProjection;
  chart: PerformanceChartSeries;
};

/** Convert shares to underlying assets. Always rounds down. */
export function underlyingFromShares(shares: string, rate: ShareRate): string {
  const s = parseQuantity(shares);
  const num = parseQuantity(rate.numerator);
  const den = parseQuantity(rate.denominator);
  if (num === 0n) throw new Error("Share rate numerator cannot be zero");
  return mulDiv(s, den, num, "down").toString(10);
}

/** Convert underlying assets to shares. Always rounds down. */
export function sharesFromUnderlying(assets: string, rate: ShareRate): string {
  const a = parseQuantity(assets);
  const num = parseQuantity(rate.numerator);
  const den = parseQuantity(rate.denominator);
  if (den === 0n) throw new Error("Share rate denominator cannot be zero");
  return mulDiv(a, num, den, "down").toString(10);
}

export type AttributeYieldParams = {
  assetId: string;
  currentUnderlyingValue: string;
  currentShares?: string | null;
  currentShareRate?: ShareRate | null;
  initialShareRate?: ShareRate | null;
  startingUnderlyingValue?: string;
  cashFlows: CashFlowEvent[];
  unclaimedRewards?: UnclaimedReward[];
  oraclePrice?: { price: string; scale: number } | null;
};

/**
 * Reconcile deposits, withdrawals, fees, rewards and share-rate changes.
 *
 * CRITICAL RULE (Acceptance Evidence 1):
 * No balance increase is called yield without cash-flow attribution.
 * External transfers, airdrops, or unexplained balance spikes are categorized
 * as unattributedInflow and strictly excluded from earnedYield.
 */
export function attributeCashFlowYield(params: AttributeYieldParams): {
  attribution: CashFlowAttribution;
  realizedEarnings: RealizedEarnings;
  accruedEstimate: AccruedEstimate;
} {
  const currentVal = parseQuantity(params.currentUnderlyingValue);
  const startVal = parseQuantity(params.startingUnderlyingValue ?? "0");

  let depositsTotal = 0n;
  let withdrawalsTotal = 0n;
  let feesTotal = 0n;
  let claimedRewardsTotal = 0n;

  for (const cf of params.cashFlows) {
    const amt = parseQuantity(cf.amount);
    if (cf.kind === "deposit") {
      depositsTotal += amt;
    } else if (cf.kind === "withdrawal") {
      withdrawalsTotal += amt;
    } else if (cf.kind === "fee") {
      feesTotal += amt;
    } else if (cf.kind === "reward_claim") {
      claimedRewardsTotal += amt;
    }
  }

  const netDeposits = depositsTotal - withdrawalsTotal;
  const costBasis = netDeposits > 0n ? netDeposits : 0n;

  // Compute legitimate yield from share rate appreciation if share rate is known
  let shareAppreciation = 0n;
  if (params.currentShares && params.currentShareRate) {
    const curAssetWorth = parseQuantity(underlyingFromShares(params.currentShares, params.currentShareRate));

    if (params.initialShareRate) {
      const initAssetWorth = parseQuantity(underlyingFromShares(params.currentShares, params.initialShareRate));
      if (curAssetWorth > initAssetWorth) {
        shareAppreciation = curAssetWorth - initAssetWorth;
      }
    } else if (curAssetWorth > costBasis) {
      shareAppreciation = curAssetWorth - costBasis;
    }
  }

  // Realized gains: if withdrawals exceed deposits, or claimed rewards
  let realizedGains = 0n;
  if (withdrawalsTotal > depositsTotal) {
    realizedGains = withdrawalsTotal - depositsTotal;
  }
  realizedGains += claimedRewardsTotal;
  if (realizedGains > feesTotal) {
    realizedGains -= feesTotal;
  } else {
    realizedGains = 0n;
  }

  // Calculate maximum attributable underlying position
  // The position can legitimately be: starting value + net deposits + share appreciation
  const legitimateExpectedValue = startVal + netDeposits + shareAppreciation;

  let unattributedInflow = 0n;
  const warnings: string[] = [];

  if (currentVal > legitimateExpectedValue) {
    unattributedInflow = currentVal - legitimateExpectedValue;
    warnings.push(
      `Balance increase of ${unattributedInflow.toString(10)} ${params.assetId} has no cash-flow or share-rate attribution; classified as unattributed inflow and excluded from earned yield.`,
    );
  }

  // Earned yield is strictly the attributed earnings: share appreciation + realized gains
  const earnedYield = shareAppreciation + realizedGains;

  const unclaimedList = params.unclaimedRewards ?? [];
  let unclaimedTotal = 0n;
  for (const r of unclaimedList) {
    if (r.assetId === params.assetId) {
      unclaimedTotal += parseQuantity(r.amount);
    }
  }

  const accruedTotal = shareAppreciation + unclaimedTotal;

  // USD conversions if oracle price provided
  const toUsd = (amt: bigint): string | null => {
    if (!params.oraclePrice) return null;
    const p = parseQuantity(params.oraclePrice.price);
    const scale = BigInt(10 ** params.oraclePrice.scale);
    return mulDiv(amt, p, scale, "down").toString(10);
  };

  const attribution: CashFlowAttribution = {
    depositsTotal: depositsTotal.toString(10),
    withdrawalsTotal: withdrawalsTotal.toString(10),
    netDeposits: netDeposits.toString(10),
    feesTotal: feesTotal.toString(10),
    claimedRewardsTotal: claimedRewardsTotal.toString(10),
    costBasis: costBasis.toString(10),
    currentValue: currentVal.toString(10),
    unattributedInflow: unattributedInflow.toString(10),
    hasUnattributedInflow: unattributedInflow > 0n,
    earnedYield: earnedYield.toString(10),
    warnings,
  };

  const realizedEarnings: RealizedEarnings = {
    amount: realizedGains.toString(10),
    usdValue: toUsd(realizedGains),
    assetId: params.assetId,
  };

  const accruedEstimate: AccruedEstimate = {
    amount: accruedTotal.toString(10),
    usdValue: toUsd(accruedTotal),
    assetId: params.assetId,
    shareAppreciationAmount: shareAppreciation.toString(10),
    unclaimedRewards: unclaimedList,
  };

  return {
    attribution,
    realizedEarnings,
    accruedEstimate,
  };
}

export type Forward30dProjectionParams = {
  principalAmount: string;
  principalUsd?: string | null;
  rateBps: string | null;
  rateStatus: ProjectionRateStatus;
  rateDisagreement?: "match" | "mismatch" | "unavailable" | null;
  isStale?: boolean;
};

/**
 * Thirty-day forward projection evaluation.
 *
 * CRITICAL RULE (Acceptance Evidence 2):
 * Thirty-day projections require current verified rates.
 * If the rate is unverified, stale, disputed, or missing:
 * - projected30dAmount must be null
 * - projected30dUsd must be null
 * - isProjectionAvailable must be false
 * - unavailableReason must be descriptive
 * NEVER return 0 or guessed values for unverified rates.
 */
export function evaluateForward30dProjection(params: Forward30dProjectionParams): Forward30dProjection {
  const isStale = params.isStale === true || params.rateStatus === "stale";
  const isDisputed = params.rateDisagreement === "mismatch" || params.rateStatus === "disputed";
  const isMissing = params.rateBps === null || params.rateStatus === "missing";
  const isUnverified = params.rateStatus === "unverified" || params.rateDisagreement === "unavailable";

  if (isStale) {
    return {
      isProjectionAvailable: false,
      projected30dAmount: null,
      projected30dUsd: null,
      rateUsedBps: params.rateBps,
      rateStatus: "stale",
      unavailableReason: "Thirty-day projections require current verified rates; current rate is stale",
    };
  }

  if (isDisputed) {
    return {
      isProjectionAvailable: false,
      projected30dAmount: null,
      projected30dUsd: null,
      rateUsedBps: params.rateBps,
      rateStatus: "disputed",
      unavailableReason:
        "Thirty-day projections require current verified rates; rate is disputed by independent node read",
    };
  }

  if (isMissing || params.rateBps === null) {
    return {
      isProjectionAvailable: false,
      projected30dAmount: null,
      projected30dUsd: null,
      rateUsedBps: null,
      rateStatus: "missing",
      unavailableReason: "Thirty-day projections require current verified rates; market has no reported rate",
    };
  }

  if (isUnverified || params.rateStatus !== "verified") {
    return {
      isProjectionAvailable: false,
      projected30dAmount: null,
      projected30dUsd: null,
      rateUsedBps: params.rateBps,
      rateStatus: "unverified",
      unavailableReason: "Thirty-day projections require current verified rates; rate is unverified",
    };
  }

  // Rate is strictly verified
  const principal = parseQuantity(params.principalAmount);
  const rateBps = parseQuantity(params.rateBps);

  // 30-day projection: principal * (rateBps / 10,000) * (30 / 365)
  // = principal * (rateBps * 30) / (3,650,000)
  const numerator = rateBps * 30n;
  const denominator = 3650000n;
  const projectedAmount = mulDiv(principal, numerator, denominator, "down").toString(10);

  let projectedUsd: string | null = null;
  if (params.principalUsd) {
    const pUsd = parseQuantity(params.principalUsd);
    projectedUsd = mulDiv(pUsd, numerator, denominator, "down").toString(10);
  }

  return {
    isProjectionAvailable: true,
    projected30dAmount: projectedAmount,
    projected30dUsd: projectedUsd,
    rateUsedBps: params.rateBps,
    rateStatus: "verified",
    unavailableReason: null,
  };
}

/**
 * Historical performance chart series.
 *
 * CRITICAL RULE (Acceptance Evidence 3):
 * History charts use two or more canonical observations and never synthetic points.
 * If total observations < 2:
 * - hasChart: false
 * - points: [] (strictly empty array)
 * - NEVER inject synthetic 0 or flatline points.
 */
export function buildPerformanceChartSeries(
  observations: CanonicalObservation[],
  costBasis: string,
): PerformanceChartSeries {
  // Validate and filter canonical observations (must have observedAt and source)
  const canonical = observations.filter(
    (obs) => typeof obs.observedAt === "string" && obs.observedAt.trim().length > 0 && typeof obs.source === "string",
  );

  if (canonical.length < 2) {
    return {
      hasChart: false,
      points: [],
      observationCount: canonical.length,
      reason:
        "Insufficient canonical observations: history charts require two or more canonical observations and never synthetic points",
    };
  }

  // Sort observations chronologically ascending
  const sorted = [...canonical].sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());

  const basis = parseQuantity(costBasis);
  const points: CanonicalPerformancePoint[] = [];

  for (const obs of sorted) {
    let underlyingVal = 0n;
    if (obs.shareRate && obs.positionShares) {
      underlyingVal = parseQuantity(underlyingFromShares(obs.positionShares, obs.shareRate));
    } else if (obs.underlyingValue) {
      underlyingVal = parseQuantity(obs.underlyingValue);
    }

    let cumYield = 0n;
    if (underlyingVal > basis) {
      cumYield = underlyingVal - basis;
    }

    points.push({
      timestamp: obs.observedAt,
      blockHeight: obs.blockHeight,
      blockHash: obs.blockHash,
      source: obs.source,
      shareRate: obs.shareRate ?? null,
      positionShares: obs.positionShares ?? null,
      underlyingValue: underlyingVal.toString(10),
      cumulativeYield: cumYield.toString(10),
    });
  }

  return {
    hasChart: true,
    points,
    observationCount: points.length,
    reason: null,
  };
}
