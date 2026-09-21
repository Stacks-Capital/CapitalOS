import type { MarketRisk, OracleQuoteView, Position } from "@stacks-capital/client";
import {
  ORACLE_MAX_AGE_MS,
  concentrationByQuantity,
  type Health,
  type OracleQuote,
  stressGraniteCollateral,
  wouldLiquidateAtLtv,
} from "@stacks-capital/core";

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
  const report = concentrationByQuantity(
    held.map((position) => ({
      key: by(position),
      quantity: position.quantity === null ? null : BigInt(position.quantity),
      assetId: position.assetId,
    })),
  );
  if (!report.available || report.total === null) {
    return unavailable(report.reason ?? "Concentration is unavailable.");
  }
  return available({
    total: report.total.toString(10),
    slices: report.slices.map((slice) => ({
      key: slice.key,
      quantity: slice.quantity.toString(10),
      shareBps: slice.shareBps.toString(10),
    })),
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

function toOracle(view: OracleQuoteView): OracleQuote | null {
  if (view.price === null) return null;
  return {
    price: BigInt(view.price),
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
 * Uses core stressGraniteCollateral so shifts never invent a base price.
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

  if (risk.params === null) {
    return {
      assumptions,
      rows: shiftsBps.map((shiftBps) => ({
        shiftBps,
        label: `${shiftBps < 0 ? "" : "+"}${(shiftBps / 100).toFixed(0)}%`,
        health: unavailable("The protocol's risk parameters could not be read."),
      })),
    };
  }
  if (risk.position.collateral === null || risk.position.debt === null) {
    return {
      assumptions,
      rows: shiftsBps.map((shiftBps) => ({
        shiftBps,
        label: `${shiftBps < 0 ? "" : "+"}${(shiftBps / 100).toFixed(0)}%`,
        health: unavailable("Your position in this market is unknown."),
      })),
    };
  }

  const collateralOracle = toOracle(risk.collateralOracle);
  const debtOracle = toOracle(risk.debtOracle);
  if (collateralOracle === null || debtOracle === null) {
    const reason =
      collateralOracle === null
        ? `No price for ${risk.collateralOracle.feedKey}.`
        : `No price for ${risk.debtOracle.feedKey}.`;
    return {
      assumptions,
      rows: shiftsBps.map((shiftBps) => ({
        shiftBps,
        label: `${shiftBps < 0 ? "" : "+"}${(shiftBps / 100).toFixed(0)}%`,
        health: unavailable(reason),
      })),
    };
  }

  const report = stressGraniteCollateral({
    collateral: {
      amount: BigInt(risk.position.collateral),
      decimals: BigInt(risk.params.collateralDecimals),
      oracle: collateralOracle,
    },
    debt: {
      amount: BigInt(risk.position.debt),
      decimals: BigInt(risk.params.debtDecimals),
      oracle: debtOracle,
    },
    params: {
      ltvBorrowBps: BigInt(risk.params.ltvBorrowBps),
      ltvLiqBps: BigInt(risk.params.ltvLiqBps),
      bufferBps: BigInt(risk.params.bufferBps),
    },
    now,
    collateralFeed: risk.collateralOracle.feedKey,
    debtFeed: risk.debtOracle.feedKey,
    shiftsBps,
  });

  return {
    assumptions: {
      ...assumptions,
      note: report.assumptions.note,
    },
    rows: report.rows.map((row) => ({
      shiftBps: row.shiftBps,
      label: row.label,
      health:
        row.health === null ? unavailable(row.unavailableReason ?? "Scenario is unavailable.") : available(row.health),
    })),
  };
}

/** True when a scenario would put the position past the liquidation threshold. */
export function wouldLiquidate(scenario: Scenario, liquidationThresholdBps: string | null): boolean {
  if (!scenario.health.available || liquidationThresholdBps === null) return false;
  return wouldLiquidateAtLtv(scenario.health.value.currentLtvBps, BigInt(liquidationThresholdBps));
}
