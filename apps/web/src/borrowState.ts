import type { MarketRisk } from "@stacks-capital/client";
import type { Health } from "@stacks-capital/core";
import type { BorrowAction, BorrowProjection } from "@stacks-capital/ui";

export type BorrowViewMode = "easy" | "advanced";

export type RiskLevel = "safe" | "moderate" | "danger" | "unknown";

export type EasyRiskSummary = {
  level: RiskLevel;
  levelLabel: string;
  badgeVariant: "badge-success" | "badge-warning" | "badge-danger" | "badge-neutral";
  liquidationPriceDropPercent: number | null;
  maxSafeBorrowUsd: number | null;
  explanation: string;
};

export type RepayAccounting = {
  currentDebt: bigint;
  amountRepaid: bigint;
  remainingDebt: bigint;
  isFullRepay: boolean;
  debtReductionPercent: number;
};

export type BorrowAccounting = {
  currentDebt: bigint;
  requestedBorrow: bigint;
  /** Null until a quote states the fee. An unquoted fee is unknown, never zero and never assumed. */
  quotedFee: bigint | null;
  /** Null while the fee is unknown, because what reaches the wallet cannot be stated without it. */
  netReceived: bigint | null;
  newTotalDebt: bigint;
};

/**
 * Calculates simplified, plain-language risk indicators for Easy Mode.
 * Determines maximum permissible collateral price drop before liquidation.
 */
export function calculateEasyRisk(health: Health | null, risk: MarketRisk | null): EasyRiskSummary {
  if (!health || !risk || !risk.params) {
    return {
      level: "unknown",
      levelLabel: "Unknown Risk",
      badgeVariant: "badge-neutral",
      liquidationPriceDropPercent: null,
      maxSafeBorrowUsd: null,
      explanation: "Position or market risk parameters are currently unavailable.",
    };
  }

  const collateralUsd = Number(health.collateralUsd);
  const debtUsd = Number(health.debtUsd);
  const ltvLiqBps = Number(risk.params.ltvLiqBps);
  const ltvBorrowBps = Number(risk.params.ltvBorrowBps);
  const currentLtvBps = Number(health.currentLtvBps);

  if (debtUsd === 0 || collateralUsd === 0) {
    return {
      level: "safe",
      levelLabel: "Unleveraged / Safe",
      badgeVariant: "badge-success",
      liquidationPriceDropPercent: 100,
      maxSafeBorrowUsd: Math.max(0, (collateralUsd * ltvBorrowBps) / 10000),
      explanation: "You have no active debt liabilities in this market.",
    };
  }

  // Max price drop percentage before collateral value breaches liquidation threshold
  // Liquidation occurs when Debt >= Collateral * (ltvLiqBps / 10000)
  // Max Drop % = (1 - (Debt / (Collateral * (ltvLiqBps / 10000)))) * 100%
  const liqCollateralThreshold = (collateralUsd * ltvLiqBps) / 10000;
  const rawDrop = liqCollateralThreshold > 0 ? (1 - debtUsd / liqCollateralThreshold) * 100 : 0;
  const liquidationPriceDropPercent = Math.max(0, Math.min(100, Math.round(rawDrop * 10) / 10));

  let level: RiskLevel = "safe";
  let levelLabel = "Safe Buffer";
  let badgeVariant: EasyRiskSummary["badgeVariant"] = "badge-success";
  let explanation = `Your collateral can withstand a ${liquidationPriceDropPercent.toFixed(1)}% Bitcoin price decline before liquidation.`;

  if (currentLtvBps >= ltvLiqBps || !health.healthy) {
    level = "danger";
    levelLabel = "Liquidation Risk";
    badgeVariant = "badge-danger";
    explanation =
      "Critical: Current liabilities exceed the safe limit. Immediate repayment or collateral addition required.";
  } else if (!health.withinBuffer || currentLtvBps >= ltvBorrowBps - 500) {
    level = "moderate";
    levelLabel = "Caution / Close to Limit";
    badgeVariant = "badge-warning";
    explanation = `Caution: Position is close to borrow limit. Collateral can only withstand a ${liquidationPriceDropPercent.toFixed(1)}% price drop.`;
  }

  const maxSafeBorrowUsd = Math.max(0, (collateralUsd * ltvBorrowBps) / 10000 - debtUsd);

  return {
    level,
    levelLabel,
    badgeVariant,
    liquidationPriceDropPercent,
    maxSafeBorrowUsd,
    explanation,
  };
}

/**
 * Calculates explicit debt repayment accounting (amount repaid, remaining balance, full repayment status).
 */
export function calculateDebtAccounting(debtBefore: bigint, repayInput: string): RepayAccounting {
  const cleanInput = repayInput.trim().toLowerCase();
  const isFull = cleanInput === "max" || cleanInput === "full";

  let amountRepaid = 0n;
  if (isFull) {
    amountRepaid = debtBefore;
  } else if (/^[0-9]+$/.test(cleanInput)) {
    const parsed = BigInt(cleanInput);
    amountRepaid = parsed > debtBefore ? debtBefore : parsed;
  }

  const remainingDebt = debtBefore > amountRepaid ? debtBefore - amountRepaid : 0n;
  const isFullRepay = debtBefore > 0n && remainingDebt === 0n;
  const debtReductionPercent = debtBefore > 0n ? Math.min(100, Number((amountRepaid * 10000n) / debtBefore) / 100) : 0;

  return {
    currentDebt: debtBefore,
    amountRepaid,
    remainingDebt,
    isFullRepay,
    debtReductionPercent,
  };
}

export type QuotedFees = {
  expectedOutput: readonly { asset: string; quantity: string }[];
  fees: readonly { amount: { asset?: string | undefined; quantity: string } }[];
};

/**
 * Reads the borrow fee out of a quote, in the borrowed asset's base units.
 *
 * Only fees denominated in the borrowed asset are counted: a network fee paid in STX does not
 * reduce the USDCx that reaches the wallet. Returns null when the quote names no borrowed asset,
 * so the caller reports the fee as unknown rather than as zero.
 */
export function quotedBorrowFee(quote: QuotedFees): bigint | null {
  const borrowed = quote.expectedOutput[0];
  if (borrowed === undefined) return null;

  let total = 0n;
  for (const fee of quote.fees) {
    if (fee.amount.asset !== borrowed.asset) continue;
    try {
      total += BigInt(fee.amount.quantity);
    } catch {
      return null;
    }
  }
  return total;
}

/**
 * Calculates explicit borrow accounting (requested borrow, quoted fees, net received, new total debt).
 *
 * The fee is whatever the quote states, in the borrowed asset's base units. There is no default
 * rate: Stacks Capital does not invent rates, and a borrow origination fee cannot be known before the
 * protocol quotes it. Pass null before a quote exists and the fee and net received stay unknown.
 */
export function calculateBorrowAccounting(
  debtBefore: bigint,
  borrowInput: string,
  quotedFee: bigint | null,
): BorrowAccounting {
  const cleanInput = borrowInput.trim();
  const requestedBorrow = /^[0-9]+$/.test(cleanInput) ? BigInt(cleanInput) : 0n;
  const netReceived = quotedFee === null ? null : requestedBorrow > quotedFee ? requestedBorrow - quotedFee : 0n;
  const newTotalDebt = debtBefore + requestedBorrow;

  return {
    currentDebt: debtBefore,
    requestedBorrow,
    quotedFee,
    netReceived,
    newTotalDebt,
  };
}

/**
 * Determines whether a borrow action is strictly safe to proceed, blocking unsafe or stale states.
 */
export function isActionSafeToProceed(
  projection: BorrowProjection | null,
  risk: MarketRisk | null,
): { canProceed: boolean; reason?: string } {
  if (!risk) {
    return { canProceed: false, reason: "Market risk parameters are not loaded." };
  }
  if (risk.collateralOracle.disagreement || risk.debtOracle.disagreement) {
    return { canProceed: false, reason: "Oracle price quorum disagreement detected. Financial actions fail closed." };
  }
  if (risk.collateralOracle.stale || risk.debtOracle.stale) {
    return { canProceed: false, reason: "Oracle price feed is stale. Please refresh before proceeding." };
  }
  if (!projection) {
    return { canProceed: false, reason: "Position projection is not ready." };
  }
  if (!projection.canProceed) {
    return { canProceed: false, reason: projection.blockers[0] ?? "Action blocked by safety policy." };
  }
  return { canProceed: true };
}
