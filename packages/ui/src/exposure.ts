import type { MarketRisk, OracleQuoteView, Position } from "@stacks-capital/client";
import { computeHealth, type Health, ORACLE_MAX_AGE_MS, type OracleQuote, oracleFresh } from "@stacks-capital/core";

/** A number the screen could not work out, and the reason. Shown as "unavailable", never as zero. */
export type Unavailable = { available: false; reason: string };
export type Available<T> = { available: true; value: T };
export type Calculated<T> = Available<T> | Unavailable;

export const unavailable = (reason: string): Unavailable => ({ available: false, reason });
const available = <T>(value: T): Available<T> => ({ available: true, value });

export type ConcentrationSlice = {
  key: string;
  quantity: string;
  /** Share of the total in basis points. */
  shareBps: string;
};

export type Concentration = Calculated<{ total: string; slices: ConcentrationSlice[] }>;

/**
 * How much of what an address holds sits in one place. Positions with an unknown quantity make the
 * whole calculation unavailable, because a share of an unknown total means nothing.
 */
export function concentrationBy(
  positions: Position[],
  by: (position: Position) => string,
  kinds: Position["kind"][] = ["supplied", "collateral"],
): Concentration {
  const held = positions.filter((position) => kinds.includes(position.kind));
  if (held.length === 0) return unavailable("No positions have been projected for this address yet.");

  const unknown = held.filter((position) => position.quantity === null);
  if (unknown.length > 0) {
    const names = [...new Set(unknown.map((position) => position.marketId))].join(", ");
    return unavailable(`Some positions are unknown (${names}), so shares cannot be worked out.`);
  }

  // Quantities in different assets are not comparable, so a mixed set is reported rather than summed.
  const assets = new Set(held.map((position) => position.assetId));
  if (assets.size > 1) return unavailable("Positions are held in different assets, which cannot be added together.");

  const totals = new Map<string, bigint>();
  let total = 0n;
  for (const position of held) {
    const quantity = BigInt(position.quantity ?? "0");
    total += quantity;
    totals.set(by(position), (totals.get(by(position)) ?? 0n) + quantity);
  }
  if (total === 0n) return unavailable("Nothing is held in these markets, so there is nothing to compare.");

  return available({
    total: total.toString(10),
    slices: [...totals.entries()]
      .map(([key, quantity]) => ({
        key,
        quantity: quantity.toString(10),
        shareBps: ((quantity * 10_000n) / total).toString(10),
      }))
      .sort((left, right) => Number(BigInt(right.shareBps) - BigInt(left.shareBps))),
  });
}

export type Scenario = {
  /** How far the collateral price moves, in basis points. Negative is a fall. */
  shiftBps: number;
  label: string;
  health: Calculated<Health>;
};

export type ScenarioAssumptions = {
  collateralFeed: string;
  debtFeed: string;
  collateralPrice: string | null;
  publishedAt: string | null;
  liquidationThresholdBps: string | null;
  note: string;
};

function toOracle(view: OracleQuoteView, priceOverride?: bigint): OracleQuote | null {
  if (view.price === null) return null;
  return {
    price: priceOverride ?? BigInt(view.price),
    scale: BigInt(view.scale),
    observedAt: view.publishedAt ?? view.observedAt,
    source: view.source,
    stale: view.stale,
    maxAgeMs: ORACLE_MAX_AGE_MS,
  };
}

export const DEFAULT_SHIFTS = [-1000, -2000, -3000, -5000];

/**
 * What the position would look like if the collateral price moved, holding everything else still.
 * The assumptions are returned beside the numbers, because a scenario without them is just a number.
 */
export function scenarios(
  risk: MarketRisk,
  now: Date,
  shiftsBps: number[] = DEFAULT_SHIFTS,
): { assumptions: ScenarioAssumptions; rows: Scenario[] } {
  const assumptions: ScenarioAssumptions = {
    collateralFeed: risk.collateralOracle.feedKey,
    debtFeed: risk.debtOracle.feedKey,
    collateralPrice: risk.collateralOracle.price,
    publishedAt: risk.collateralOracle.publishedAt,
    liquidationThresholdBps: risk.params?.ltvLiqBps ?? null,
    note: "Only the collateral price moves. Debt, interest and the protocol's parameters are held still.",
  };

  const blocker = (): string | null => {
    if (risk.params === null) return "The protocol's risk parameters could not be read.";
    if (risk.position.collateral === null || risk.position.debt === null)
      return "Your position in this market is unknown.";
    const collateral = toOracle(risk.collateralOracle);
    const debt = toOracle(risk.debtOracle);
    if (collateral === null) return `No price for ${risk.collateralOracle.feedKey}.`;
    if (debt === null) return `No price for ${risk.debtOracle.feedKey}.`;
    if (!oracleFresh(collateral, now)) return `The ${risk.collateralOracle.feedKey} price is stale.`;
    if (!oracleFresh(debt, now)) return `The ${risk.debtOracle.feedKey} price is stale.`;
    return null;
  };

  const reason = blocker();
  const rows = shiftsBps.map((shiftBps) => {
    const label = `${shiftBps < 0 ? "" : "+"}${(shiftBps / 100).toFixed(0)}%`;
    if (reason !== null || risk.params === null) return { shiftBps, label, health: unavailable(reason ?? "") };

    const base = BigInt(risk.collateralOracle.price ?? "0");
    const moved = (base * BigInt(10_000 + shiftBps)) / 10_000n;
    const collateral = toOracle(risk.collateralOracle, moved);
    const debt = toOracle(risk.debtOracle);
    if (collateral === null || debt === null) return { shiftBps, label, health: unavailable("A price is missing.") };

    const health = computeHealth({
      collateral: {
        amount: BigInt(risk.position.collateral ?? "0"),
        decimals: BigInt(risk.params.collateralDecimals),
        oracle: collateral,
      },
      debt: { amount: BigInt(risk.position.debt ?? "0"), decimals: BigInt(risk.params.debtDecimals), oracle: debt },
      params: {
        ltvBorrowBps: BigInt(risk.params.ltvBorrowBps),
        ltvLiqBps: BigInt(risk.params.ltvLiqBps),
        bufferBps: BigInt(risk.params.bufferBps),
      },
      now,
    });
    return { shiftBps, label, health: available(health) };
  });

  return { assumptions, rows };
}

/** True when a scenario would put the position past the liquidation threshold. */
export function wouldLiquidate(scenario: Scenario, liquidationThresholdBps: string | null): boolean {
  if (!scenario.health.available || liquidationThresholdBps === null) return false;
  return scenario.health.value.currentLtvBps >= BigInt(liquidationThresholdBps);
}
