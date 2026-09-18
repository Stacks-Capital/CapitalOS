import type { MarketRisk, OracleQuoteView, Plan, Quote } from "@stacks-capital/client";
import {
  type Health,
  ORACLE_MAX_AGE_MS,
  type OracleQuote,
  oracleFresh,
  projectedHealth,
  settleRepayAmount,
  unsignedSteps,
} from "@stacks-capital/core";

export type BorrowAction = "collateral_add" | "borrow" | "repay" | "collateral_remove";

export type BorrowInputs = {
  action: BorrowAction;
  /** Base units, as the user typed them. */
  amount: string;
  /** What the wallet holds of the asset being sent, when it is known. */
  walletBalance?: string | null;
  /** Pause and liquidity from a quote snapshot. Missing means not yet checked. */
  paused?: boolean;
  availableLiquidity?: string | null;
};

export type BorrowProjection = {
  health: Health | null;
  /** Reasons the action cannot be signed. Empty means it can. */
  blockers: string[];
  notes: string[];
  canProceed: boolean;
};

function toOracle(view: OracleQuoteView): OracleQuote | null {
  if (view.price === null) return null;
  return {
    price: BigInt(view.price),
    scale: BigInt(view.scale),
    // Staleness is measured from when the oracle published, not from when we read it.
    observedAt: view.publishedAt ?? view.observedAt,
    source: view.source,
    stale: view.stale,
    maxAgeMs: ORACLE_MAX_AGE_MS,
  };
}

function parseAmount(value: string): bigint | null {
  return /^[0-9]+$/.test(value.trim()) && value.trim() !== "" ? BigInt(value.trim()) : null;
}

/** Which side of the position the action moves, and in which direction. */
export function deltasFor(action: BorrowAction, amount: bigint): { collateral: bigint; debt: bigint } {
  switch (action) {
    case "collateral_add":
      return { collateral: amount, debt: 0n };
    case "collateral_remove":
      return { collateral: -amount, debt: 0n };
    case "borrow":
      return { collateral: 0n, debt: amount };
    case "repay":
      return { collateral: 0n, debt: -amount };
    default:
      return { collateral: 0n, debt: 0n };
  }
}

/**
 * Projects what the position would look like after an action, and says plainly why it cannot go ahead.
 * Nothing is assumed: a missing price, a missing parameter or an unknown current position each block it.
 */
export function projectBorrow(risk: MarketRisk, inputs: BorrowInputs, now: Date): BorrowProjection {
  const blockers: string[] = [];
  const notes: string[] = [...risk.warnings, ...risk.position.warnings];

  const collateralOracle = toOracle(risk.collateralOracle);
  const debtOracle = toOracle(risk.debtOracle);
  if (collateralOracle === null) blockers.push(`No price for ${risk.collateralOracle.feedKey}.`);
  else if (!oracleFresh(collateralOracle, now)) blockers.push(`The ${risk.collateralOracle.feedKey} price is stale.`);
  if (debtOracle === null) blockers.push(`No price for ${risk.debtOracle.feedKey}.`);
  else if (!oracleFresh(debtOracle, now)) blockers.push(`The ${risk.debtOracle.feedKey} price is stale.`);

  if (risk.params === null) blockers.push("The protocol's risk parameters could not be read.");

  const collateralBefore = risk.position.collateral === null ? null : BigInt(risk.position.collateral);
  const debtBefore = risk.position.debt === null ? null : BigInt(risk.position.debt);
  if (collateralBefore === null || debtBefore === null) {
    blockers.push("Your current position in this market is unknown, so the result cannot be projected.");
  }

  if (inputs.paused) blockers.push("This market is paused.");

  let amount: bigint | null = null;
  if (inputs.action === "repay" && debtBefore !== null) {
    const settled = settleRepayAmount(inputs.amount, debtBefore);
    if ("error" in settled) blockers.push(settled.error);
    else amount = settled.amount;
  } else {
    amount = parseAmount(inputs.amount);
    if (amount === null) blockers.push("Enter an amount in base units.");
    else if (amount === 0n) blockers.push("Enter an amount greater than zero.");
  }

  if (
    inputs.action === "borrow" &&
    amount !== null &&
    inputs.availableLiquidity !== null &&
    inputs.availableLiquidity !== undefined &&
    /^[0-9]+$/.test(inputs.availableLiquidity) &&
    amount > BigInt(inputs.availableLiquidity)
  ) {
    blockers.push("There is not enough USDCx liquidity for this borrow.");
  }

  // Sending more than the wallet holds fails at the wallet, so it is caught before signing.
  const sending = inputs.action === "collateral_add" || inputs.action === "repay";
  if (sending && amount !== null) {
    const balance = inputs.walletBalance ?? null;
    if (balance === null) notes.push("Your wallet balance is unknown, so this amount is not checked against it.");
    else if (BigInt(balance) < amount) blockers.push("That is more than your wallet holds.");
  }

  if (
    blockers.length > 0 ||
    amount === null ||
    risk.params === null ||
    collateralBefore === null ||
    debtBefore === null ||
    collateralOracle === null ||
    debtOracle === null
  ) {
    return { health: null, blockers, notes, canProceed: false };
  }

  const deltas = deltasFor(inputs.action, amount);
  if (deltas.collateral < 0n && collateralBefore + deltas.collateral < 0n) {
    blockers.push("That is more collateral than you have in this market.");
  }
  if (deltas.debt < 0n && debtBefore + deltas.debt < 0n) blockers.push("That is more than you owe.");
  if (blockers.length > 0) return { health: null, blockers, notes, canProceed: false };

  const health = projectedHealth({
    collateralBefore,
    debtBefore,
    collateralDelta: deltas.collateral,
    debtDelta: deltas.debt,
    collateral: { decimals: BigInt(risk.params.collateralDecimals), oracle: collateralOracle },
    debt: { decimals: BigInt(risk.params.debtDecimals), oracle: debtOracle },
    params: {
      ltvBorrowBps: BigInt(risk.params.ltvBorrowBps),
      ltvLiqBps: BigInt(risk.params.ltvLiqBps),
      bufferBps: BigInt(risk.params.bufferBps),
    },
    now,
  });

  if (!health.healthy) blockers.push("This would leave the position above the borrow limit.");
  else if (!health.withinBuffer) notes.push("This leaves the position inside the safety buffer, close to the limit.");
  notes.push(...health.warnings);

  return { health, blockers, notes, canProceed: blockers.length === 0 };
}

export function snapshotValue(snapshots: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`;
  const found = snapshots.find((item) => item.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

/** Quote snapshots the adapter already computed. Pause or missing liquidity cannot be signed. */
export function quoteSafety(quote: Quote): { paused: boolean; availableLiquidity: string | null; blockers: string[] } {
  const paused = snapshotValue(quote.snapshots, "pause") === "on";
  const liquidity = snapshotValue(quote.snapshots, "liquidity");
  const blockers: string[] = [];
  if (paused) blockers.push("This market is paused.");
  if (quote.action === "borrow" && (liquidity === undefined || liquidity === "unknown")) {
    blockers.push("Borrow liquidity was not read.");
  }
  return {
    paused,
    availableLiquidity: liquidity === undefined || liquidity === "unknown" ? null : liquidity,
    blockers,
  };
}

export function nextBorrowStep(plan: Plan, confirmedStepIds: readonly string[]) {
  return unsignedSteps(plan, confirmedStepIds)[0];
}

/** Oracle source and time the review screen must show before a signature. */
export function oracleProvenance(risk: MarketRisk): string[] {
  return [
    `${risk.collateralOracle.feedKey} ${risk.collateralOracle.source} at ${risk.collateralOracle.publishedAt ?? risk.collateralOracle.observedAt}`,
    `${risk.debtOracle.feedKey} ${risk.debtOracle.source} at ${risk.debtOracle.publishedAt ?? risk.debtOracle.observedAt}`,
  ];
}

/** The action each screen control maps to, so the API is asked for the right quote. */
export const QUOTE_ACTION: Record<BorrowAction, string> = {
  collateral_add: "supply",
  collateral_remove: "withdraw_supply",
  borrow: "borrow",
  repay: "repay",
};
