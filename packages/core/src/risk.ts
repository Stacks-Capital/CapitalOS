import { mulDiv, type Rounding } from "./amounts.ts";
import { capitalError } from "./errors.ts";

export const BPS = 10_000n;
export const USD_SCALE = 8n;
export const ORACLE_MAX_AGE_MS = 180_000;

export type OracleQuote = {
  price: bigint;
  scale: bigint;
  observedAt: string;
  source: string;
  stale: boolean;
  maxAgeMs: number;
};

export type AssetRiskSide = {
  amount: bigint;
  decimals: bigint;
  oracle: OracleQuote;
};

export type RiskParams = {
  ltvBorrowBps: bigint;
  ltvLiqBps: bigint;
  bufferBps: bigint;
};

export type Health = {
  collateralUsd: bigint;
  debtUsd: bigint;
  currentLtvBps: bigint;
  healthFactorBps: bigint;
  maxBorrow: bigint;
  liquidationThresholdBps: bigint;
  withinBuffer: boolean;
  healthy: boolean;
  stale: boolean;
  warnings: string[];
};

export function pow10(decimals: bigint): bigint {
  if (decimals < 0n) throw new Error("decimals cannot be negative");
  let out = 1n;
  for (let i = 0n; i < decimals; i++) out *= 10n;
  return out;
}

export function oracleAgeMs(oracle: OracleQuote, now: Date): number {
  return now.getTime() - Date.parse(oracle.observedAt);
}

export function oracleFresh(oracle: OracleQuote, now: Date): boolean {
  if (oracle.stale) return false;
  const age = oracleAgeMs(oracle, now);
  return Number.isFinite(age) && age >= 0 && age <= oracle.maxAgeMs;
}

export function assertOracleFresh(oracle: OracleQuote, now: Date, label: string): void {
  if (oracleFresh(oracle, now)) return;
  const age = oracleAgeMs(oracle, now);
  throw capitalError("ORACLE_STALE", `${label} oracle is stale or age ${age}ms exceeds ${oracle.maxAgeMs}ms`);
}

export function usdNotional(side: AssetRiskSide, rounding: Rounding): bigint {
  if (side.oracle.scale !== USD_SCALE) throw new Error("oracle scale must be 8");
  return mulDiv(side.amount, side.oracle.price, pow10(side.decimals), rounding);
}

export function computeHealth(input: {
  collateral: AssetRiskSide;
  debt: AssetRiskSide;
  params: RiskParams;
  now: Date;
}): Health {
  const warnings: string[] = [];
  if (!oracleFresh(input.collateral.oracle, input.now) || !oracleFresh(input.debt.oracle, input.now)) {
    return {
      collateralUsd: 0n,
      debtUsd: 0n,
      currentLtvBps: 0n,
      healthFactorBps: 0n,
      maxBorrow: 0n,
      liquidationThresholdBps: input.params.ltvLiqBps,
      withinBuffer: false,
      healthy: false,
      stale: true,
      warnings: ["oracle is stale; health and LTV are unavailable"],
    };
  }

  const collateralUsd = usdNotional(input.collateral, "down");
  const debtUsd = usdNotional(input.debt, "up");
  const currentLtvBps = collateralUsd === 0n ? BPS * 10n : mulDiv(debtUsd, BPS, collateralUsd, "up");
  const healthFactorBps =
    debtUsd === 0n ? BPS * 10n : mulDiv(collateralUsd * input.params.ltvLiqBps, 1n, debtUsd, "down");
  const bufferLimit =
    input.params.ltvBorrowBps > input.params.bufferBps ? input.params.ltvBorrowBps - input.params.bufferBps : 0n;
  const maxDebtUsd = mulDiv(collateralUsd, bufferLimit, BPS, "down");
  const maxBorrow = mulDiv(maxDebtUsd, pow10(input.debt.decimals), input.debt.oracle.price, "down");
  const healthy = healthFactorBps >= BPS && currentLtvBps <= input.params.ltvBorrowBps;
  const withinBuffer = debtUsd === 0n || currentLtvBps <= bufferLimit;
  if (!withinBuffer && healthy) warnings.push("projected LTV is inside the buffer to liquidation");
  if (input.params.ltvLiqBps <= input.params.ltvBorrowBps)
    warnings.push("liquidation threshold must be above borrow LTV");
  return {
    collateralUsd,
    debtUsd,
    currentLtvBps,
    healthFactorBps,
    maxBorrow,
    liquidationThresholdBps: input.params.ltvLiqBps,
    withinBuffer,
    healthy,
    stale: false,
    warnings,
  };
}

export function projectedHealth(input: {
  collateralBefore: bigint;
  debtBefore: bigint;
  collateralDelta: bigint;
  debtDelta: bigint;
  collateral: Omit<AssetRiskSide, "amount">;
  debt: Omit<AssetRiskSide, "amount">;
  params: RiskParams;
  now: Date;
}): Health {
  const collateralAmount = input.collateralBefore + input.collateralDelta;
  const debtAmount = input.debtBefore + input.debtDelta;
  return computeHealth({
    collateral: { ...input.collateral, amount: collateralAmount < 0n ? 0n : collateralAmount },
    debt: { ...input.debt, amount: debtAmount < 0n ? 0n : debtAmount },
    params: input.params,
    now: input.now,
  });
}

export function minOutFromSpot(amountOut: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps >= BPS) throw new Error("slippage must be between 0 and 9999 bps");
  return mulDiv(amountOut, BPS - slippageBps, BPS, "down");
}

export function marketsComparable(
  left: { protocol: string; action: string },
  right: { protocol: string; action: string },
): boolean {
  return left.action === right.action && left.protocol === right.protocol;
}
