import type { Rate } from "./compare.ts";

export type SimulationHorizon = 30 | 90 | 180 | 365;

export type SimulationInput = {
  /** Numeric string representing the deposited principal amount (e.g. "1.50" or "10000"). */
  principal: string;
  baseRate: Rate | null;
  incentiveRate: Rate | null;
  horizonDays: number;
  marketId?: string | undefined;
  assetId?: string | undefined;
  isStale?: boolean | undefined;
  confidence?: "high" | "medium" | "low" | undefined;
  disagreement?: "match" | "mismatch" | "unavailable" | null | undefined;
};

export type SimulationResult = {
  principalAmount: number;
  horizonDays: number;
  baseApyPercent: number;
  incentiveApyPercent: number;
  effectiveApyPercent: number;
  baseYieldAmount: number;
  incentiveYieldAmount: number;
  totalYieldAmount: number;
  projectedEndingBalance: number;
  isReliable: boolean;
  disclosures: string[];
  warnings: string[];
};

function rateToFraction(rate: Rate | null): number {
  if (rate === null) return 0;
  const val = Number(rate.value);
  if (!Number.isFinite(val) || val <= 0) return 0;
  return val / 10 ** rate.scale;
}

/**
 * Deterministic strategy simulator modeling prospective earnings from verified rates.
 * Acceptance criteria:
 * 1. Projected earnings use exact disclosed inputs without hidden multipliers.
 * 2. No provider-only or stale value is presented as verified.
 */
export function simulateEarn(input: SimulationInput): SimulationResult {
  const principal = Number.parseFloat(input.principal.trim() || "0");
  const validPrincipal = Number.isFinite(principal) && principal > 0 ? principal : 0;
  const horizonDays = Math.max(1, Math.min(3650, Math.floor(input.horizonDays || 30)));

  const baseFraction = rateToFraction(input.baseRate);
  const incentiveFraction = rateToFraction(input.incentiveRate);
  const totalFraction = baseFraction + incentiveFraction;

  const baseApyPercent = baseFraction * 100;
  const incentiveApyPercent = incentiveFraction * 100;
  const effectiveApyPercent = totalFraction * 100;

  const horizonFraction = horizonDays / 365;
  const baseYieldAmount = validPrincipal * baseFraction * horizonFraction;
  const incentiveYieldAmount = validPrincipal * incentiveFraction * horizonFraction;
  const totalYieldAmount = baseYieldAmount + incentiveYieldAmount;
  const projectedEndingBalance = validPrincipal + totalYieldAmount;

  const warnings: string[] = [];
  let isReliable = true;

  if (validPrincipal === 0) {
    warnings.push("Principal amount must be greater than zero.");
    isReliable = false;
  }

  if (input.baseRate === null) {
    warnings.push("Base APY rate is unread or unavailable; projection may be incomplete.");
    isReliable = false;
  }

  if (input.isStale) {
    warnings.push("Market rate reading is stale; active onchain yields may differ.");
    isReliable = false;
  }

  if (input.confidence === "low") {
    warnings.push("Evidence confidence is low; reconciliation detected missing or unverified inputs.");
    isReliable = false;
  }

  if (input.disagreement === "mismatch") {
    warnings.push("Independent onchain reads disagree with provider-reported rate.");
    isReliable = false;
  }

  const disclosures: string[] = [
    `Linear annualized projection at ${effectiveApyPercent.toFixed(2)}% APY (${baseApyPercent.toFixed(2)}% base + ${incentiveApyPercent.toFixed(2)}% incentives) over ${horizonDays} days.`,
    "Projections assume continuous deposit with constant rate and no early withdrawal fees.",
    "Incentive yields are subject to protocol token emission schedules and secondary market price volatility.",
  ];

  return {
    principalAmount: validPrincipal,
    horizonDays,
    baseApyPercent,
    incentiveApyPercent,
    effectiveApyPercent,
    baseYieldAmount,
    incentiveYieldAmount,
    totalYieldAmount,
    projectedEndingBalance,
    isReliable,
    disclosures,
    warnings,
  };
}
