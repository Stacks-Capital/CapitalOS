import type { StacksNetwork } from "@stacks-capital/core";

/**
 * I37 — Liquidity provision state logic.
 *
 * Provides pure data types and calculation helpers for Bitflow LP pool display,
 * range/bin disclosure, impermanent loss estimation, exit liquidity depth, and
 * LP position accounting. All values are integer base units or exact string math.
 *
 * NOTE: apps/web uses only public packages (core, sdk, client, wallets, react, ui).
 * Capability gating is done through the web app's own pool allowlist and the
 * client SDK's capabilities endpoint rather than importing config/adapters directly.
 */

// ---------------------------------------------------------------------------
// Canonical LP pool definition
// ---------------------------------------------------------------------------

export type LpTokenPair = { x: LpAssetDef; y: LpAssetDef };

export type LpAssetDef = {
  symbol: string;
  name: string;
  decimals: number;
  contractId: string;
  feedKey: string;
};

export const SBTC_DEF: LpAssetDef = {
  symbol: "sBTC",
  name: "Stacks Bitcoin",
  decimals: 8,
  contractId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  feedKey: "BTC/USD",
};

export const USDCX_DEF: LpAssetDef = {
  symbol: "USDCx",
  name: "Bridged USDC",
  decimals: 6,
  contractId: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token",
  feedKey: "USDC/USD",
};

/**
 * Pilot Blocker B6: Live pool principals that are pinned on mainnet.
 * Currently empty — no LP pools are verified and allowlisted.
 * This mirrors BITFLOW_ALLOWED_POOLS in @stacks-capital/config without importing it.
 */
export const ALLOWED_POOL_PRINCIPALS: readonly string[] = [];

export type LiquidityPoolView = {
  poolId: string;
  protocol: "bitflow";
  pair: LpTokenPair;
  feeTierBps: number;
  activePriceDisplay: string | null;
  /** DLMM bin configuration */
  activeBinId: number | null;
  binStepBps: number | null;
  /** Disclosed range bounds (human-readable prices) */
  rangeLower: string | null;
  rangeUpper: string | null;
  inRange: boolean;
  /** Pool-level metrics */
  tvlUsd: string | null;
  deployableCapacity: string | null;
  exitLiquidity: ExitLiquidityInfo;
  /** Capability gating */
  executable: boolean;
  capabilityState: "enabled" | "disabled" | "paused" | "unavailable";
  capabilityReason: string;
  /** Provenance */
  observedAt: string | null;
  source: string | null;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Exit liquidity
// ---------------------------------------------------------------------------

export type ExitLiquidityInfo = {
  /** Total reserves available for immediate exit in base units */
  reserveX: string;
  reserveY: string;
  /** Estimated slippage for a full exit based on pool depth, bps */
  estimatedSlippageBps: number | null;
  /** Unbonding constraints */
  lockType: "instant" | "time_locked" | "unknown";
  unbondingDays: number | null;
  /** Human readable depth description */
  depthDescription: string;
};

// ---------------------------------------------------------------------------
// Impermanent loss estimation
// ---------------------------------------------------------------------------

/**
 * IL = 2√k / (1+k) - 1, where k = P₁ / P₀ (price ratio).
 * This is the standard CPMM IL formula. DLMM concentrated bins may amplify IL.
 */
export type ImpermanentLossEstimate = {
  priceChangePercent: number;
  k: number;
  ilPercent: number;
  formulaDisclosure: string;
  limitations: string[];
};

const IL_FORMULA_DISCLOSURE =
  "IL(k) = 2√k / (1+k) − 1, where k = P₁/P₀. This assumes a standard constant-product model; concentrated (DLMM) bins may amplify impermanent loss.";

const IL_LIMITATIONS: readonly string[] = [
  "Actual IL depends on the specific bin range and concentration.",
  "Trading fees earned may partially or fully offset IL.",
  "This model assumes a single price change; real prices fluctuate continuously.",
  "DLMM binned positions may experience higher IL than computed here.",
];

export function calculateImpermanentLoss(priceChangePercent: number): ImpermanentLossEstimate {
  const k = 1 + priceChangePercent / 100;
  if (k <= 0) {
    return {
      priceChangePercent,
      k,
      ilPercent: -100,
      formulaDisclosure: IL_FORMULA_DISCLOSURE,
      limitations: [...IL_LIMITATIONS],
    };
  }
  const il = (2 * Math.sqrt(k)) / (1 + k) - 1;
  return {
    priceChangePercent,
    k,
    ilPercent: Math.round(il * 10000) / 100, // two decimal places, as percent
    formulaDisclosure: IL_FORMULA_DISCLOSURE,
    limitations: [...IL_LIMITATIONS],
  };
}

/** Preset IL scenarios for the UI divergence simulator. */
export const IL_SCENARIOS = [5, 10, 25, 50, -5, -10, -25, -50] as const;
export type IlScenarioPercent = (typeof IL_SCENARIOS)[number];

export function ilScenarios(): ImpermanentLossEstimate[] {
  return IL_SCENARIOS.map((pct) => calculateImpermanentLoss(pct));
}

// ---------------------------------------------------------------------------
// LP position accounting
// ---------------------------------------------------------------------------

export type LpAccounting = {
  totalLpTokens: bigint;
  userLpTokens: bigint;
  poolShareBps: bigint;
  pooledX: bigint;
  pooledY: bigint;
  unclaimedFeesX: bigint;
  unclaimedFeesY: bigint;
};

/**
 * Pure LP accounting. All values are integer base units.
 * Share % = (user LP / total LP) × 10000 bps.
 */
export function calculateLpAccounting(input: {
  totalLpTokens: bigint;
  userLpTokens: bigint;
  reserveX: bigint;
  reserveY: bigint;
  unclaimedFeesX: bigint;
  unclaimedFeesY: bigint;
}): LpAccounting {
  const { totalLpTokens, userLpTokens, reserveX, reserveY, unclaimedFeesX, unclaimedFeesY } = input;

  if (totalLpTokens === 0n) {
    return {
      totalLpTokens: 0n,
      userLpTokens: 0n,
      poolShareBps: 0n,
      pooledX: 0n,
      pooledY: 0n,
      unclaimedFeesX: 0n,
      unclaimedFeesY: 0n,
    };
  }

  const poolShareBps = (userLpTokens * 10000n) / totalLpTokens;
  const pooledX = (reserveX * userLpTokens) / totalLpTokens;
  const pooledY = (reserveY * userLpTokens) / totalLpTokens;

  return {
    totalLpTokens,
    userLpTokens,
    poolShareBps,
    pooledX,
    pooledY,
    unclaimedFeesX,
    unclaimedFeesY,
  };
}

// ---------------------------------------------------------------------------
// LP capability gating
// ---------------------------------------------------------------------------

export type LpAction = "add_liquidity" | "remove_liquidity" | "claim_fees";

/**
 * Checks whether an LP action is executable on the given network.
 * Returns `executable: false` if:
 * - The pool principal is not in ALLOWED_POOL_PRINCIPALS (B6 pilot blocker).
 * - Testnet is always unavailable (no Bitflow LP testnet deployment).
 */
export function isLpActionExecutable(
  _action: LpAction,
  network: StacksNetwork,
  poolPrincipal: string | null,
): { executable: boolean; reason: string } {
  if (network === "testnet") {
    return {
      executable: false,
      reason: "Bitflow LP pools are not deployed on the Stacks testnet.",
    };
  }

  // Primary guard: ALLOWED_POOL_PRINCIPALS must contain the pool to enable any LP action
  if (poolPrincipal === null || !ALLOWED_POOL_PRINCIPALS.includes(poolPrincipal)) {
    return {
      executable: false,
      reason:
        "Live pool principal is not pinned on mainnet (Pilot Blocker B6). LP actions are unavailable until pools are verified and allowlisted.",
    };
  }

  return { executable: true, reason: "Pool is allowlisted and LP capability is enabled." };
}

/**
 * Builds a view model for a known Bitflow DLMM pool.
 * Since ALLOWED_POOL_PRINCIPALS is currently empty, this always returns an unavailable pool.
 */
export function buildPoolView(poolPrincipal: string | null, network: StacksNetwork): LiquidityPoolView {
  const { executable, reason } = isLpActionExecutable("add_liquidity", network, poolPrincipal);

  return {
    poolId: poolPrincipal ?? "bitflow.sbtc-usdcx.dlmm",
    protocol: "bitflow",
    pair: { x: SBTC_DEF, y: USDCX_DEF },
    feeTierBps: 30,
    activePriceDisplay: null,
    activeBinId: null,
    binStepBps: null,
    rangeLower: null,
    rangeUpper: null,
    inRange: false,
    tvlUsd: null,
    deployableCapacity: null,
    exitLiquidity: {
      reserveX: "0",
      reserveY: "0",
      estimatedSlippageBps: null,
      lockType: "instant",
      unbondingDays: null,
      depthDescription: "Exit liquidity data unavailable — pool is not yet allowlisted.",
    },
    executable,
    capabilityState: executable ? "enabled" : "unavailable",
    capabilityReason: reason,
    observedAt: null,
    source: "config:ALLOWED_POOL_PRINCIPALS",
    warnings: executable ? [] : [reason],
  };
}
