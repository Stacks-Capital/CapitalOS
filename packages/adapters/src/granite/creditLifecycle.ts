import { capabilityFor, contract, findContract } from "@stacks-capital/config";
import {
  assertOracleFresh,
  parseQuantity,
  projectedHealth,
  settleRepayAmount,
  type Action,
  type Health,
  type OracleQuote,
  type RiskParams,
  type StacksNetwork,
} from "@stacks-capital/core";
import type { AdapterReads, OracleSnapshot } from "../reads.ts";

export const GRANITE_RATE_SCALE = 4;

export type GraniteCreditAction = "supply" | "withdraw_supply" | "borrow" | "repay";

export type GranitePositionEvidence = {
  collateral: string;
  debt: string;
  /** Protocol-reported accrued debt when distinct from the stored principal. */
  accruedDebt: string | null;
  observedAt: string;
  source: string;
};

export type GraniteMarketEvidence = {
  borrowPaused: boolean;
  repayPaused: boolean;
  liquidityUsdcx: string | null;
  interestRateBps: string | null;
  riskParams: {
    ltvBorrowBps: string;
    ltvLiqBps: string;
    bufferBps: string;
    sbtcDecimals: string;
    usdcxDecimals: string;
  };
  oracle: { sbtc: OracleSnapshot; usdcx: OracleSnapshot };
};

export type GraniteCreditIntent = {
  action: GraniteCreditAction;
  network: StacksNetwork;
  owner: string;
  amount: string;
  collateralAmount?: string;
  recipient?: string;
  onBehalfOf?: string;
  idempotencyKey: string;
};

export type CanonicalGraniteSettlement = {
  kind: "granite_collateral_add" | "granite_collateral_remove" | "granite_borrow" | "granite_repay";
  stacksTxid: string;
  blockHeight: number;
  blockHash: string;
  canonical: boolean;
  assetMoved: string;
  owner: string;
};

export type GraniteCreditState =
  | "unavailable"
  | "oracle_stale"
  | "paused"
  | "liquidity_blocked"
  | "health_blocked"
  | "awaiting_signature"
  | "submitted"
  | "confirming"
  | "reconciled"
  | "reconciliation_failed";

export type GraniteCreditLifecycle = {
  transferId: string;
  action: GraniteCreditAction;
  network: StacksNetwork;
  state: GraniteCreditState;
  complete: boolean;
  nextAction: "WAIT" | "SIGN" | "CONTACT_SUPPORT" | "COMPLETE" | "UNAVAILABLE";
  broadcastAllowed: false;
  contracts: { market: string; sbtc: string; usdcx: string };
  repay: {
    requested: string;
    settledAmount: string | null;
    isRepayAll: boolean;
    accruedDebt: string | null;
    remainingDebt: string | null;
  };
  health: {
    currentLtvBps: string | null;
    healthFactorBps: string | null;
    maxBorrow: string | null;
    withinBuffer: boolean | null;
    healthy: boolean | null;
    stale: boolean;
  };
  observed: {
    stacksTxid: string | null;
    assetMoved: string | null;
    collateral: string | null;
    debt: string | null;
  };
  warnings: string[];
};

export function graniteCreditTransferId(
  network: StacksNetwork,
  action: GraniteCreditAction,
  idempotencyKey: string,
): string {
  return `${network}:granite:${action}:${idempotencyKey}`;
}

function asOracle(snapshot: OracleSnapshot): OracleQuote {
  return {
    price: parseQuantity(snapshot.price),
    scale: parseQuantity(snapshot.scale),
    observedAt: snapshot.observedAt,
    source: snapshot.source,
    stale: snapshot.stale,
    maxAgeMs: snapshot.maxAgeMs,
  };
}

export function marketFromReads(reads: AdapterReads, now: Date): GraniteMarketEvidence | { error: string } {
  if (reads.oracle === undefined || reads.riskParams === undefined) {
    return { error: "Granite quotes require oracle and risk parameters" };
  }
  try {
    assertOracleFresh(asOracle(reads.oracle.sbtc), now, "sBTC");
    assertOracleFresh(asOracle(reads.oracle.usdcx), now, "USDCx");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "oracle is stale" };
  }
  return {
    borrowPaused: reads.debtVault?.pausedRedeem === true,
    repayPaused: false,
    liquidityUsdcx: reads.debtVault?.totalAssets ?? null,
    interestRateBps: reads.debtVault?.interestRateBps ?? null,
    riskParams: reads.riskParams,
    oracle: reads.oracle,
  };
}

export function settleGraniteRepay(
  requested: string,
  position: GranitePositionEvidence,
): { amount: string; isRepayAll: boolean; accruedDebt: string } | { error: string } {
  const accrued = position.accruedDebt ?? position.debt;
  const settled = settleRepayAmount(requested, parseQuantity(accrued));
  if ("error" in settled) return { error: settled.error };
  return {
    amount: settled.amount.toString(10),
    isRepayAll: requested === "max" || settled.amount === parseQuantity(accrued),
    accruedDebt: accrued,
  };
}

function project(
  intent: GraniteCreditIntent,
  position: GranitePositionEvidence,
  market: GraniteMarketEvidence,
  now: Date,
): Health {
  const params: RiskParams = {
    ltvBorrowBps: parseQuantity(market.riskParams.ltvBorrowBps),
    ltvLiqBps: parseQuantity(market.riskParams.ltvLiqBps),
    bufferBps: parseQuantity(market.riskParams.bufferBps),
  };
  const collateralBefore = parseQuantity(position.collateral);
  const debtBefore = parseQuantity(position.accruedDebt ?? position.debt);
  const collateralDelta =
    intent.action === "supply"
      ? parseQuantity(intent.amount)
      : intent.action === "withdraw_supply"
        ? -parseQuantity(intent.amount)
        : intent.collateralAmount !== undefined
          ? parseQuantity(intent.collateralAmount)
          : 0n;
  const debtDelta =
    intent.action === "borrow"
      ? parseQuantity(intent.amount)
      : intent.action === "repay"
        ? -parseQuantity(intent.amount)
        : 0n;
  return projectedHealth({
    collateralBefore,
    debtBefore,
    collateralDelta,
    debtDelta,
    collateral: {
      decimals: parseQuantity(market.riskParams.sbtcDecimals),
      oracle: asOracle(market.oracle.sbtc),
    },
    debt: {
      decimals: parseQuantity(market.riskParams.usdcxDecimals),
      oracle: asOracle(market.oracle.usdcx),
    },
    params,
    now,
  });
}

/**
 * Rebuild the Granite credit lifecycle from market, position and optional canonical settlement.
 * Reloads keep the same transfer id and never permit a second broadcast.
 */
export function evaluateGraniteCredit(input: {
  intent: GraniteCreditIntent;
  market: GraniteMarketEvidence | null;
  position: GranitePositionEvidence | null;
  settlement: CanonicalGraniteSettlement | null;
  broadcastKnown: boolean;
  now: Date;
}): GraniteCreditLifecycle {
  const transferId = graniteCreditTransferId(input.intent.network, input.intent.action, input.intent.idempotencyKey);
  const capability = capabilityFor(input.intent.action as Action, input.intent.network, "granite");
  const marketId = findContract("granite", "v0-8-market", input.intent.network)?.contractId ?? "unavailable";
  const sbtcId = findContract("sbtc", "sbtc-token", input.intent.network)?.contractId ?? "unavailable";
  const usdcxId = findContract("usdcx", "usdcx", input.intent.network)?.contractId ?? "unavailable";
  const warnings: string[] = [];

  const emptyHealth = {
    currentLtvBps: null,
    healthFactorBps: null,
    maxBorrow: null,
    withinBuffer: null,
    healthy: null,
    stale: true,
  };

  const emptyRepay = {
    requested: input.intent.amount,
    settledAmount: null,
    isRepayAll: false,
    accruedDebt: input.position?.accruedDebt ?? input.position?.debt ?? null,
    remainingDebt: null,
  };

  const lifecycle = (
    state: GraniteCreditState,
    nextAction: GraniteCreditLifecycle["nextAction"],
    complete: boolean,
    extras: {
      warnings?: string[];
      health?: GraniteCreditLifecycle["health"];
      repay?: GraniteCreditLifecycle["repay"];
    } = {},
  ): GraniteCreditLifecycle => ({
    transferId,
    action: input.intent.action,
    network: input.intent.network,
    state,
    complete,
    nextAction,
    broadcastAllowed: false,
    contracts: { market: marketId, sbtc: sbtcId, usdcx: usdcxId },
    repay: extras.repay ?? emptyRepay,
    health: extras.health ?? emptyHealth,
    observed: {
      stacksTxid: input.settlement?.stacksTxid ?? null,
      assetMoved: input.settlement?.assetMoved ?? null,
      collateral: input.position?.collateral ?? null,
      debt: input.position?.accruedDebt ?? input.position?.debt ?? null,
    },
    warnings: [...warnings, ...(extras.warnings ?? [])],
  });

  if (input.intent.network !== "mainnet" || capability?.state !== "enabled") {
    return lifecycle("unavailable", "UNAVAILABLE", false, {
      warnings: [capability?.reason ?? "Granite v0-8-market is not available on this network"],
    });
  }
  if (input.market === null || input.position === null) {
    return lifecycle("unavailable", "UNAVAILABLE", false, {
      warnings: ["Granite market or position evidence is missing"],
    });
  }

  let repayView: GraniteCreditLifecycle["repay"] = emptyRepay;
  let settledAmount = input.intent.amount;
  let intentForHealth = input.intent;
  if (input.intent.action === "repay") {
    const settled = settleGraniteRepay(input.intent.amount, input.position);
    if ("error" in settled) {
      return lifecycle("health_blocked", "UNAVAILABLE", false, {
        warnings: [settled.error],
      });
    }
    settledAmount = settled.amount;
    intentForHealth = { ...input.intent, amount: settled.amount };
    const remaining = parseQuantity(settled.accruedDebt) - parseQuantity(settled.amount);
    repayView = {
      requested: input.intent.amount,
      settledAmount: settled.amount,
      isRepayAll: settled.isRepayAll,
      accruedDebt: settled.accruedDebt,
      remainingDebt: remaining < 0n ? "0" : remaining.toString(10),
    };
  }

  let health: Health;
  try {
    health = project(intentForHealth, input.position, input.market, input.now);
  } catch (error) {
    return lifecycle("oracle_stale", "UNAVAILABLE", false, {
      warnings: [error instanceof Error ? error.message : "oracle is stale"],
      repay: repayView,
    });
  }
  if (health.stale) {
    return lifecycle("oracle_stale", "UNAVAILABLE", false, {
      warnings: health.warnings.length > 0 ? health.warnings : ["oracle is stale"],
      health: {
        currentLtvBps: health.currentLtvBps.toString(10),
        healthFactorBps: health.healthFactorBps.toString(10),
        maxBorrow: health.maxBorrow.toString(10),
        withinBuffer: health.withinBuffer,
        healthy: health.healthy,
        stale: true,
      },
      repay: repayView,
    });
  }

  const healthView = {
    currentLtvBps: health.currentLtvBps.toString(10),
    healthFactorBps: health.healthFactorBps.toString(10),
    maxBorrow: health.maxBorrow.toString(10),
    withinBuffer: health.withinBuffer,
    healthy: health.healthy,
    stale: false,
  };

  if (input.intent.action === "borrow" && input.market.borrowPaused) {
    return lifecycle("paused", "UNAVAILABLE", false, {
      warnings: ["USDCx debt vault is paused"],
      health: healthView,
      repay: repayView,
    });
  }

  if (input.intent.action === "borrow") {
    const qty = parseQuantity(input.intent.amount);
    if (input.market.liquidityUsdcx !== null && qty > parseQuantity(input.market.liquidityUsdcx)) {
      return lifecycle("liquidity_blocked", "UNAVAILABLE", false, {
        warnings: ["USDCx vault liquidity is insufficient"],
        health: healthView,
        repay: repayView,
      });
    }
    const collateral =
      parseQuantity(input.position.collateral) +
      (input.intent.collateralAmount !== undefined ? parseQuantity(input.intent.collateralAmount) : 0n);
    if (collateral <= 0n) {
      return lifecycle("health_blocked", "UNAVAILABLE", false, {
        warnings: ["isolated collateral is required before borrow"],
        health: healthView,
        repay: repayView,
      });
    }
    if (!health.healthy || parseQuantity(input.position.debt) + qty > health.maxBorrow) {
      return lifecycle("health_blocked", "UNAVAILABLE", false, {
        warnings: [`borrow exceeds max ${health.maxBorrow.toString(10)} or projected LTV`],
        health: healthView,
        repay: repayView,
      });
    }
  }

  if (input.intent.action === "withdraw_supply" && !health.healthy) {
    return lifecycle("health_blocked", "UNAVAILABLE", false, {
      warnings: ["projected health is above borrow LTV"],
      health: healthView,
      repay: repayView,
    });
  }

  if (input.settlement === null) {
    return lifecycle(
      input.broadcastKnown ? "submitted" : "awaiting_signature",
      input.broadcastKnown ? "WAIT" : "SIGN",
      false,
      { health: healthView, repay: repayView },
    );
  }

  if (!input.settlement.canonical) {
    return lifecycle("confirming", "WAIT", false, {
      warnings: ["Granite settlement is not yet on a canonical Stacks block"],
      health: healthView,
      repay: repayView,
    });
  }

  const expectedKind: CanonicalGraniteSettlement["kind"] =
    input.intent.action === "supply"
      ? "granite_collateral_add"
      : input.intent.action === "withdraw_supply"
        ? "granite_collateral_remove"
        : input.intent.action === "borrow"
          ? "granite_borrow"
          : "granite_repay";
  const mismatches: string[] = [];
  if (input.settlement.kind !== expectedKind) {
    mismatches.push(`expected ${expectedKind}, observed ${input.settlement.kind}`);
  }
  if (input.settlement.owner !== input.intent.owner && input.settlement.owner !== input.intent.recipient) {
    mismatches.push("settlement owner does not match the intent");
  }
  const expectedAsset = input.intent.action === "repay" ? settledAmount : input.intent.amount;
  if (input.settlement.assetMoved !== expectedAsset) {
    mismatches.push(`asset moved ${input.settlement.assetMoved} !== expected ${expectedAsset}`);
  }
  if (mismatches.length > 0) {
    return lifecycle("reconciliation_failed", "CONTACT_SUPPORT", false, {
      warnings: mismatches,
      health: healthView,
      repay: repayView,
    });
  }

  return lifecycle("reconciled", "COMPLETE", true, { health: healthView, repay: repayView });
}

export function graniteContracts(network: StacksNetwork): { market: string; sbtc: string; usdcx: string } {
  return {
    market: contract("granite", "v0-8-market", network).contractId,
    sbtc: contract("sbtc", "sbtc-token", network).contractId,
    usdcx: contract("usdcx", "usdcx", network).contractId,
  };
}
