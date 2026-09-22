import type { StacksNetwork } from "@stacks-capital/core";

/**
 * I37 — Staking state logic.
 *
 * Distinguishes three categories products often conflate:
 *  1. Native Bitcoin / PoX staking  (L1 Bitcoin lock, NOT sBTC DeFi)
 *  2. STX stacking                  (StackingDAO liquid stacking)
 *  3. Protocol receipt staking      (Hermetica USDH/sUSDh, zsBTC earn receipts)
 *
 * K33 certifies that unsupported routes never appear executable.
 *
 * NOTE: apps/web uses only public packages (core, sdk, client, wallets, react, ui).
 * Staking availability is self-contained here. The adapters package lifecycle functions
 * are not imported; this module implements the same K33 invariant independently.
 */

// ---------------------------------------------------------------------------
// Category taxonomy
// ---------------------------------------------------------------------------

export type StakingCategory = "native_bitcoin" | "stx_stacking" | "protocol_receipt";

export type StakingRouteView = {
  id: string;
  name: string;
  protocol: string;
  category: StakingCategory;
  categoryLabel: string;
  categoryBadge: string;
  /** Input/receipt asset identifiers */
  assetIn: string;
  receiptAsset: string | null;
  /** Lockup and custody */
  lockupPeriodBlocks: number | null;
  unbondingDays: number | null;
  custodyModel: "l1_bitcoin_consensus" | "smart_contract_lock" | "escrow_vault" | "liquid";
  custodyDescription: string;
  /** Exchange rate for protocol receipt assets (e.g. sUSDh share price) */
  exchangeRate: ExchangeRateInfo | null;
  /** Yield provenance */
  rewardsProvenance: RewardsProvenance;
  /** Capability state — K33 invariant: unsupported never executable */
  executable: boolean;
  broadcastAllowed: boolean;
  capabilityState: "enabled" | "disabled" | "paused" | "unavailable";
  capabilityReason: string;
  distinctions: string[];
  warnings: string[];
};

export type ExchangeRateInfo = {
  rate: string;
  source: string;
  observedAt: string | null;
  stale: boolean;
};

export type RewardsProvenance = {
  source: string;
  timestamp: string | null;
  confidence: "verified" | "provider_reported" | "unknown";
  note: string;
};

// ---------------------------------------------------------------------------
// K33 distinctions — shared between routes for consistency
// ---------------------------------------------------------------------------

const NATIVE_BITCOIN_DISTINCTIONS: readonly string[] = [
  "Native Bitcoin / PoX staking locks L1 Bitcoin. It is not sBTC DeFi supply.",
  "zsBTC earn receipts are not staking positions.",
  "pox-5 also exposes unstake / unstake-sbtc; those stay disabled with the same lockup-signing gate.",
  "Wallet lockup-signing evidence is still missing; Stacks Capital will not invent a stake plan.",
];

// ---------------------------------------------------------------------------
// Canonical staking routes
// ---------------------------------------------------------------------------

function nativeBitcoinRoute(network: StacksNetwork): StakingRouteView {
  const reason = "K02/K16: pox-5 exists but BTC lockup signing path is unverified. Staking remains disabled.";
  return {
    id: `pox.native_btc.${network}`,
    name: "Native Bitcoin Staking (PoX)",
    protocol: "pox",
    category: "native_bitcoin",
    categoryLabel: "Native Bitcoin / PoX",
    categoryBadge: "category-native-btc",
    assetIn: "BTC (Layer 1)",
    receiptAsset: null,
    lockupPeriodBlocks: 2100,
    unbondingDays: null,
    custodyModel: "l1_bitcoin_consensus",
    custodyDescription: "Bitcoin is locked on the L1 chain via pox-5. Lockup-signing path is unverified (K16).",
    exchangeRate: null,
    rewardsProvenance: {
      source: "Stacks PoX consensus",
      timestamp: null,
      confidence: "unknown",
      note: "PoX yield depends on Stacks block rewards and participation rate. Not yet verified.",
    },
    executable: false,
    broadcastAllowed: false,
    capabilityState: "unavailable",
    capabilityReason: reason,
    distinctions: [...NATIVE_BITCOIN_DISTINCTIONS],
    warnings: [reason, ...NATIVE_BITCOIN_DISTINCTIONS],
  };
}

function stxStackingRoute(network: StacksNetwork): StakingRouteView {
  const reason = "StackingDAO capability has not been implemented or verified in this release.";
  return {
    id: `stackingdao.stx.${network}`,
    name: "STX Liquid Stacking (StackingDAO)",
    protocol: "stackingdao",
    category: "stx_stacking",
    categoryLabel: "STX Stacking",
    categoryBadge: "category-stx",
    assetIn: "STX",
    receiptAsset: "stSTX",
    lockupPeriodBlocks: null,
    unbondingDays: 14,
    custodyModel: "smart_contract_lock",
    custodyDescription:
      "STX is delegated to a StackingDAO stacking pool. stSTX receipt tokens are redeemable after the cooldown period.",
    exchangeRate: {
      rate: "provider_reported",
      source: "StackingDAO",
      observedAt: null,
      stale: true,
    },
    rewardsProvenance: {
      source: "StackingDAO protocol",
      timestamp: null,
      confidence: "provider_reported",
      note: "Yield is derived from Stacks stacking rewards distributed via StackingDAO. Provider-reported rates remain labeled as such.",
    },
    executable: false,
    broadcastAllowed: false,
    capabilityState: "unavailable",
    capabilityReason: reason,
    distinctions: [
      "stSTX is a liquid stacking receipt, not a staking position.",
      "Unstaking requires a 14-day cooldown period.",
      "STX stacking is distinct from native Bitcoin L1 staking.",
    ],
    warnings: [reason],
  };
}

function hermeticaReceiptRoute(network: StacksNetwork): StakingRouteView {
  const reason = "Hermetica USDH/sUSDh capability has not been implemented or verified in this release.";
  return {
    id: `hermetica.usdh.${network}`,
    name: "Protocol Receipt Staking (Hermetica sUSDh)",
    protocol: "hermetica",
    category: "protocol_receipt",
    categoryLabel: "Protocol Receipt",
    categoryBadge: "category-receipt",
    assetIn: "USDH",
    receiptAsset: "sUSDh",
    lockupPeriodBlocks: null,
    unbondingDays: null,
    custodyModel: "escrow_vault",
    custodyDescription:
      "USDH is deposited into a Hermetica vault. sUSDh receipt tokens represent the share of the vault.",
    exchangeRate: {
      rate: "provider_reported",
      source: "Hermetica",
      observedAt: null,
      stale: true,
    },
    rewardsProvenance: {
      source: "Hermetica protocol",
      timestamp: null,
      confidence: "provider_reported",
      note: "Rewards accrue via sUSDh share price appreciation. Provider-reported rates remain labeled and cannot become verified through repetition.",
    },
    executable: false,
    broadcastAllowed: false,
    capabilityState: "unavailable",
    capabilityReason: reason,
    distinctions: [
      "sUSDh is a yield vault receipt, not a staking position.",
      "zsBTC earn receipts are not staking positions.",
      "Protocol receipt staking is distinct from native Bitcoin staking and STX stacking.",
    ],
    warnings: [reason],
  };
}

/**
 * Returns all canonical staking routes for a network, each with explicit category,
 * capability state, and distinctions. K33 invariant: unsupported routes are documented
 * and never executable.
 */
export function getStakingRoutes(network: StacksNetwork): StakingRouteView[] {
  return [nativeBitcoinRoute(network), stxStackingRoute(network), hermeticaReceiptRoute(network)];
}

/**
 * Validates that a staking route is strictly signable (executable and broadcast allowed).
 * Native Bitcoin staking and all unverified routes unconditionally return false.
 */
export function isStakingSignable(route: StakingRouteView): {
  canSign: boolean;
  reason: string;
} {
  if (!route.executable) {
    return { canSign: false, reason: route.capabilityReason };
  }
  if (!route.broadcastAllowed) {
    return { canSign: false, reason: "Broadcast is not allowed for this staking route." };
  }
  return { canSign: true, reason: "Route is executable and broadcast is permitted." };
}

/**
 * Groups routes by category for rendering in the staking screen.
 */
export function groupByCategory(routes: StakingRouteView[]): Map<StakingCategory, StakingRouteView[]> {
  const groups = new Map<StakingCategory, StakingRouteView[]>();
  for (const route of routes) {
    const existing = groups.get(route.category) ?? [];
    existing.push(route);
    groups.set(route.category, existing);
  }
  return groups;
}
