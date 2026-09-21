import { BITFLOW_ALLOWED_POOLS, capabilityFor, findContract } from "@stacks-capital/config";
import { capitalError, minOutFromSpot, parseQuantity, type StacksNetwork } from "@stacks-capital/core";
import type { SwapSnapshot } from "../reads.ts";
import { MAX_SLIPPAGE_BPS } from "./swap.ts";

export const BITFLOW_DEFAULT_SLIPPAGE_BPS = 50n;
export { MAX_SLIPPAGE_BPS };

export type BitflowSwapIntent = {
  network: StacksNetwork;
  owner: string;
  amount: string;
  minOut: string;
  poolId: string;
  routerId: string;
  inputAsset: "sbtc" | "usdcx";
  idempotencyKey: string;
  quotedAt: string;
  expiresAt: string;
};

export type CanonicalBitflowSettlement = {
  stacksTxid: string;
  blockHeight: number;
  blockHash: string;
  canonical: boolean;
  amountIn: string;
  amountOut: string;
  poolId: string;
  owner: string;
};

export type BitflowSwapState =
  | "unavailable"
  | "route_stale"
  | "quote_expired"
  | "route_changed"
  | "awaiting_signature"
  | "submitted"
  | "confirming"
  | "reconciled"
  | "reconciliation_failed";

export type BitflowSwapLifecycle = {
  transferId: string;
  network: StacksNetwork;
  state: BitflowSwapState;
  complete: boolean;
  nextAction: "WAIT" | "SIGN" | "REQUOTE" | "CONTACT_SUPPORT" | "COMPLETE" | "UNAVAILABLE";
  broadcastAllowed: false;
  contracts: { router: string; pool: string };
  quote: {
    amountIn: string;
    amountOut: string | null;
    minOut: string;
    expiresAt: string;
    source: string | null;
  };
  observed: {
    stacksTxid: string | null;
    amountIn: string | null;
    amountOut: string | null;
  };
  warnings: string[];
};

export function bitflowSwapTransferId(network: StacksNetwork, idempotencyKey: string): string {
  return `${network}:bitflow:swap:${idempotencyKey}`;
}

export function assertBitflowRoute(
  intent: BitflowSwapIntent,
  swap: SwapSnapshot | null,
  now: Date,
): { ok: true; amountOut: string; minOut: string } | { ok: false; state: BitflowSwapState; warnings: string[] } {
  if (swap === null) return { ok: false, state: "route_stale", warnings: ["Bitflow route snapshot is missing"] };
  const age = now.getTime() - Date.parse(swap.observedAt);
  if (swap.stale || !Number.isFinite(age) || age < 0 || age > swap.maxAgeMs) {
    return { ok: false, state: "route_stale", warnings: ["Bitflow ticker/route is stale; requote required"] };
  }
  if (now.getTime() > Date.parse(intent.expiresAt)) {
    return { ok: false, state: "quote_expired", warnings: ["Quote expired; requote before signing"] };
  }
  if (swap.routerId !== intent.routerId || swap.poolId !== intent.poolId || swap.amountIn !== intent.amount) {
    return {
      ok: false,
      state: "route_changed",
      warnings: ["Route or amount changed since the quote; requote before signing"],
    };
  }
  if (BITFLOW_ALLOWED_POOLS.length > 0 && !BITFLOW_ALLOWED_POOLS.includes(intent.poolId)) {
    return { ok: false, state: "unavailable", warnings: ["Bitflow pool is not allowlisted"] };
  }
  if (BITFLOW_ALLOWED_POOLS.length === 0 && swap.source !== "fixture") {
    return { ok: false, state: "unavailable", warnings: ["no verified sBTC/USDCx Bitflow pool is pinned"] };
  }
  const amountOut = swap.amountOut;
  const minOut = intent.minOut;
  if (parseQuantity(minOut) > parseQuantity(amountOut)) {
    return { ok: false, state: "quote_expired", warnings: ["min-out is above the quoted amount"] };
  }
  return { ok: true, amountOut, minOut };
}

export function evaluateBitflowSwap(input: {
  intent: BitflowSwapIntent;
  swap: SwapSnapshot | null;
  settlement: CanonicalBitflowSettlement | null;
  broadcastKnown: boolean;
  now: Date;
}): BitflowSwapLifecycle {
  const transferId = bitflowSwapTransferId(input.intent.network, input.intent.idempotencyKey);
  const capability = capabilityFor("swap", input.intent.network, "bitflow");
  const router = findContract("bitflow", "dlmm-swap-router-v-1-2", input.intent.network)?.contractId ?? "unavailable";
  const warnings: string[] = [];

  const lifecycle = (
    state: BitflowSwapState,
    nextAction: BitflowSwapLifecycle["nextAction"],
    complete: boolean,
    extras: { warnings?: string[]; amountOut?: string | null } = {},
  ): BitflowSwapLifecycle => ({
    transferId,
    network: input.intent.network,
    state,
    complete,
    nextAction,
    broadcastAllowed: false,
    contracts: { router, pool: input.intent.poolId },
    quote: {
      amountIn: input.intent.amount,
      amountOut: extras.amountOut ?? input.swap?.amountOut ?? null,
      minOut: input.intent.minOut,
      expiresAt: input.intent.expiresAt,
      source: input.swap?.source ?? null,
    },
    observed: {
      stacksTxid: input.settlement?.stacksTxid ?? null,
      amountIn: input.settlement?.amountIn ?? null,
      amountOut: input.settlement?.amountOut ?? null,
    },
    warnings: [...warnings, ...(extras.warnings ?? [])],
  });

  if (input.intent.network !== "mainnet" || capability?.state !== "enabled") {
    return lifecycle("unavailable", "UNAVAILABLE", false, {
      warnings: [capability?.reason ?? "Bitflow swap is not available on this network"],
    });
  }

  const route = assertBitflowRoute(input.intent, input.swap, input.now);
  if (!route.ok) {
    const next =
      route.state === "quote_expired" || route.state === "route_changed" || route.state === "route_stale"
        ? "REQUOTE"
        : "UNAVAILABLE";
    return lifecycle(route.state, next, false, { warnings: route.warnings });
  }

  if (input.settlement === null) {
    return lifecycle(
      input.broadcastKnown ? "submitted" : "awaiting_signature",
      input.broadcastKnown ? "WAIT" : "SIGN",
      false,
      { amountOut: route.amountOut },
    );
  }

  if (!input.settlement.canonical) {
    return lifecycle("confirming", "WAIT", false, {
      warnings: ["Swap settlement is not yet on a canonical Stacks block"],
      amountOut: route.amountOut,
    });
  }

  const mismatches: string[] = [];
  if (input.settlement.owner !== input.intent.owner) mismatches.push("settlement owner does not match");
  if (input.settlement.poolId !== input.intent.poolId) mismatches.push("settlement pool does not match the quote");
  if (input.settlement.amountIn !== input.intent.amount) {
    mismatches.push(`amount in ${input.settlement.amountIn} !== ${input.intent.amount}`);
  }
  if (parseQuantity(input.settlement.amountOut) < parseQuantity(input.intent.minOut)) {
    mismatches.push(`amount out ${input.settlement.amountOut} is below min-out ${input.intent.minOut}`);
  }
  if (mismatches.length > 0) {
    return lifecycle("reconciliation_failed", "CONTACT_SUPPORT", false, {
      warnings: mismatches,
      amountOut: route.amountOut,
    });
  }

  return lifecycle("reconciled", "COMPLETE", true, { amountOut: route.amountOut });
}

export function previewBitflowMinOut(amountOut: string, slippageBps = BITFLOW_DEFAULT_SLIPPAGE_BPS): string {
  const slippage = typeof slippageBps === "bigint" ? slippageBps : parseQuantity(String(slippageBps));
  if (slippage < 0n || slippage > MAX_SLIPPAGE_BPS) {
    throw capitalError("PLAN_INVALID", `slippage must be between 0 and ${MAX_SLIPPAGE_BPS.toString(10)} bps`);
  }
  return minOutFromSpot(parseQuantity(amountOut), slippage).toString(10);
}
