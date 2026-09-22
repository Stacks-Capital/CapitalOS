import type { EarnOption } from "@stacks-capital/client";

export type Rate = { value: string; scale: number };

export type ComparisonRow = {
  option: EarnOption;
  /** 1 is the best in its group. Null means this option is shown but not ranked. */
  rank: number | null;
  effectiveRate: Rate | null;
  /** Why it is not ranked, or what to keep in mind if it is. Never empty when rank is null. */
  notes: string[];
};

export type ComparisonGroup = {
  /** Options are only ranked against others supplying the same asset. */
  suppliedAssetId: string | null;
  rows: ComparisonRow[];
};

export type Comparison = { groups: ComparisonGroup[]; note: string };

export const GROUPING_NOTE =
  "Options are ranked only against others that supply the same asset. Anything else is listed, not ranked.";

/** Market evidence older than five minutes cannot drive a ranking or allocation. */
export const EARN_OPTION_MAX_AGE_MS = 5 * 60 * 1000;

// Whether an option can be ranked is decided once, next to the reason, never by reading the notes back.
type Candidate = ComparisonRow & { rankable: boolean };

function toScale(rate: Rate, scale: number): bigint {
  const difference = BigInt(scale - rate.scale);
  return difference >= 0n ? BigInt(rate.value) * 10n ** difference : BigInt(rate.value) / 10n ** -difference;
}

/** Adds two rates that may be quoted at different scales, keeping the finer one. */
export function addRates(left: Rate, right: Rate | null): Rate {
  if (right === null) return left;
  const scale = Math.max(left.scale, right.scale);
  return {
    value: (toScale(left, scale) + toScale(right, scale)).toString(10),
    scale,
  };
}

function rateOf(value: string | null, scale: number | null): Rate | null {
  return value === null || scale === null ? null : { value, scale };
}

/**
 * Turns the facts the API serves into a comparison.
 *
 * The rule the task names is that nothing incomparable is ranked silently. Options supplying
 * different assets are never ranked against each other, and anything that cannot be compared
 * on equal terms, because it is paused, locked, stale or missing a rate, is listed with the reason.
 */
export function compareEarn(options: EarnOption[], now: Date): Comparison {
  const groups = new Map<string, Candidate[]>();

  for (const option of options) {
    const notes: string[] = [];
    const base = rateOf(option.baseRate, option.baseRateScale);
    const incentive = rateOf(option.incentiveRate, option.incentiveRateScale);
    let rankable = true;

    if (option.supply.state !== "enabled") {
      notes.push(`Supply is ${option.supply.state}: ${option.supply.reason}`);
      rankable = false;
    }
    if (option.paused === true) {
      notes.push("The market is paused.");
      rankable = false;
    }
    // A strategy you cannot leave is not the same product as one you can, so it is never ranked beside it.
    if (option.withdrawal === null) {
      notes.push("No withdrawal action is listed for this market.");
      rankable = false;
    } else if (option.withdrawal.state !== "enabled") {
      notes.push(`Withdrawal is ${option.withdrawal.state}: ${option.withdrawal.reason}`);
      rankable = false;
    }
    if (base === null) {
      notes.push("No rate has been read for this market yet.");
      rankable = false;
    }
    if (option.stale) {
      notes.push("The last reading is stale.");
      rankable = false;
    }
    const observedAtMs = option.observedAt === null ? null : Date.parse(option.observedAt);
    if (observedAtMs === null) {
      notes.push("The reading has no observation timestamp.");
      rankable = false;
    } else if (!Number.isFinite(observedAtMs)) {
      notes.push("The observation timestamp is invalid.");
      rankable = false;
    } else {
      const ageMs = now.getTime() - observedAtMs;
      if (!Number.isFinite(ageMs)) {
        notes.push("The observation timestamp is invalid.");
        rankable = false;
      } else if (ageMs < 0) {
        notes.push("The observation timestamp is in the future.");
        rankable = false;
      } else if (ageMs > EARN_OPTION_MAX_AGE_MS) {
        notes.push(`Last read ${Math.ceil(ageMs / 1000)} seconds ago; the limit is 300 seconds.`);
        rankable = false;
      }
    }
    if (option.capacity === "0" || option.availableLiquidity === "0") {
      notes.push("Capacity or available liquidity is exhausted.");
      rankable = false;
    }
    if (option.evidence?.confidence === "low") {
      notes.push("Evidence confidence is low; reconciliation detected disagreement or missing verification.");
      rankable = false;
    }
    if (option.evidence?.disagreement === "mismatch") {
      notes.push("Independent onchain reads disagree with reported values.");
      rankable = false;
    }
    // A missing incentive rate is not the same as no incentive, so the caveat stays visible.
    if (base !== null && incentive === null) notes.push("Incentive rate unknown, so only the base rate is counted.");
    if (option.availableLiquidity === null) notes.push("Available liquidity is unknown.");

    const row: Candidate = {
      option,
      rank: null,
      effectiveRate: base === null ? null : addRates(base, incentive),
      notes,
      rankable,
    };
    const key = option.suppliedAssetId ?? "unknown";
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }

  const result: ComparisonGroup[] = [];
  for (const [key, rows] of groups) {
    const ordered = rows
      .filter((row) => row.rankable && row.effectiveRate !== null)
      .sort((left, right) => compareRates(right.effectiveRate, left.effectiveRate));
    for (const [index, row] of ordered.entries()) row.rank = index + 1;
    result.push({
      suppliedAssetId: key === "unknown" ? null : key,
      rows: [...rows]
        .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
        .map(({ rankable: _rankable, ...row }) => row),
    });
  }

  return {
    groups: result.sort((left, right) => (left.suppliedAssetId ?? "").localeCompare(right.suppliedAssetId ?? "")),
    note: GROUPING_NOTE,
  };
}

export function compareRates(left: Rate | null, right: Rate | null): number {
  if (left === null || right === null) return 0;
  const scale = Math.max(left.scale, right.scale);
  const difference = toScale(left, scale) - toScale(right, scale);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

/** A rate as a percentage string, for display only. */
export function formatRate(rate: Rate | null): string {
  if (rate === null) return "unknown";
  const percent = Number(rate.value) / 10 ** (rate.scale - 2);
  return `${percent.toFixed(2)}%`;
}
