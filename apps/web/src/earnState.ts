import type { EarnOption } from "@stacks-capital/client";

export type EarnActionType = "supply" | "withdraw_supply";
export type EarnViewMode = "marketplace" | "simulator";

export function filterEarnOptions(options: readonly EarnOption[], assetFilter: string): EarnOption[] {
  if (!assetFilter || assetFilter.toLowerCase() === "all") return [...options];
  return options.filter((o) => (o.suppliedAssetId ?? "").toLowerCase() === assetFilter.toLowerCase());
}

export function canSupplyOption(option: EarnOption | undefined | null): boolean {
  if (!option) return false;
  return option.supply.state === "enabled" && option.paused !== true;
}

export function canWithdrawOption(option: EarnOption | undefined | null): boolean {
  if (!option) return false;
  return option.withdrawal?.state === "enabled" && option.paused !== true;
}

export function formatEvidenceBadge(option: EarnOption): {
  label: string;
  variant: "badge-success" | "badge-neutral" | "badge-warning" | "badge-danger";
  isMismatch: boolean;
} {
  const isMismatch = option.evidence?.disagreement === "mismatch";
  if (option.stale) {
    return { label: "Stale Reading", variant: "badge-danger", isMismatch };
  }
  if (option.evidence?.confidence === "high") {
    return { label: "Verified Onchain", variant: "badge-success", isMismatch };
  }
  if (option.evidence?.confidence === "low") {
    return { label: "Low Confidence", variant: "badge-warning", isMismatch };
  }
  return { label: "Active Read", variant: "badge-neutral", isMismatch };
}

export function calculateStrategyReturns(
  principal: string,
  baseRateBps: number,
  incentiveRateBps: number,
  days: number,
): {
  principalAmount: number;
  baseYieldAmount: number;
  incentiveYieldAmount: number;
  totalYieldAmount: number;
  projectedEndingBalance: number;
  effectiveApyPercent: number;
} {
  const p = Number.parseFloat(principal.trim()) || 0;
  const validP = Number.isFinite(p) && p > 0 ? p : 0;
  const baseFraction = baseRateBps / 10000;
  const incFraction = incentiveRateBps / 10000;
  const horizonFraction = days / 365;

  const baseGain = validP * baseFraction * horizonFraction;
  const incGain = validP * incFraction * horizonFraction;
  const totalGain = baseGain + incGain;

  return {
    principalAmount: validP,
    baseYieldAmount: baseGain,
    incentiveYieldAmount: incGain,
    totalYieldAmount: totalGain,
    projectedEndingBalance: validP + totalGain,
    effectiveApyPercent: (baseFraction + incFraction) * 100,
  };
}
