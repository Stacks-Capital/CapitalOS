import { capabilityFor, findContract } from "@stacks-capital/config";
import { mulDiv, parseQuantity, type StacksNetwork } from "@stacks-capital/core";
import type { VaultSnapshot } from "../reads.ts";

/** Protocol `get-interest-rate` returns basis points; Stacks Capital never annualises or compounds it. */
export const ZEST_RATE_SCALE = 4;

export type ZestEarnAction = "supply" | "withdraw_supply";

export type ZestVaultMarketEvidence = {
  totalAssets: string;
  availableAssets: string | null;
  capSupply: string;
  /** Raw `get-interest-rate` value. Null means the rate cannot drive rankings or projections. */
  interestRateBps: string | null;
  shareRateNumerator: string;
  shareRateDenominator: string;
  pausedDeposit: boolean;
  pausedRedeem: boolean;
  observedAt: string;
  source: string;
  blockHeight: number | null;
  blockHash: string | null;
};

export type ZestEarnIntent = {
  action: ZestEarnAction;
  network: StacksNetwork;
  owner: string;
  amount: string;
  minOut: string;
  recipient: string;
  /** Wallet or API idempotency key. Never invent a second write under a new key. */
  idempotencyKey: string;
};

export type CanonicalVaultSettlement = {
  kind: "zest_deposit" | "zest_redeem";
  stacksTxid: string;
  blockHeight: number;
  blockHash: string;
  canonical: boolean;
  /** Underlying sBTC moved by the vault call. */
  assetsMoved: string;
  /** zsBTC share delta. */
  sharesMoved: string;
  owner: string;
};

export type ObservedShareBalance = {
  /** Raw zsBTC share units from SIP-010. */
  shareBalance: string;
  source: string;
};

export type ZestEarnState =
  | "unavailable"
  | "paused"
  | "cap_blocked"
  | "awaiting_signature"
  | "submitted"
  | "confirming"
  | "reconciled"
  | "reconciliation_failed";

export type ZestSupplyApr = {
  rateBps: string | null;
  scale: typeof ZEST_RATE_SCALE;
  /** Exact protocol meaning — never rewritten as APY or compounded yield. */
  meaning: string;
  rankingAllowed: boolean;
  projectedEarningsAllowed: boolean;
};

export type ZestReceiptValuation = {
  receiptAssetId: string;
  receiptUnits: string;
  underlyingAssetId: string;
  underlyingUnits: string | null;
  /** Receipts never add a second portfolio total. */
  countsReceiptTowardPortfolio: false;
  note: string;
};

export type ZestEarnLifecycle = {
  transferId: string;
  action: ZestEarnAction;
  network: StacksNetwork;
  state: ZestEarnState;
  complete: boolean;
  nextAction: "WAIT" | "SIGN" | "CONTACT_SUPPORT" | "COMPLETE" | "UNAVAILABLE";
  /** Watchers and reloads never broadcast a second vault write. */
  broadcastAllowed: false;
  contracts: { vault: string };
  market: {
    totalAssets: string;
    availableAssets: string | null;
    capSupply: string;
    remainingCapacity: string | null;
    pausedDeposit: boolean;
    pausedRedeem: boolean;
    shareRate: { numerator: string; denominator: string };
    observedAt: string;
    source: string;
    blockHeight: number | null;
    blockHash: string | null;
  };
  apr: ZestSupplyApr;
  valuation: ZestReceiptValuation;
  expected: { assets: string; shares: string; minOut: string };
  observed: {
    stacksTxid: string | null;
    assetsMoved: string | null;
    sharesMoved: string | null;
    shareBalance: string | null;
    underlyingClaim: string | null;
  };
  warnings: string[];
};

export function zestEarnTransferId(network: StacksNetwork, action: ZestEarnAction, idempotencyKey: string): string {
  return `${network}:zest:${action}:${idempotencyKey}`;
}

export function vaultMarketFromSnapshot(
  vault: VaultSnapshot,
  meta: { observedAt: string; source: string; blockHeight?: number | null; blockHash?: string | null },
): ZestVaultMarketEvidence {
  return {
    totalAssets: vault.totalAssets,
    availableAssets: vault.availableAssets ?? null,
    capSupply: vault.capSupply,
    interestRateBps: vault.interestRateBps ?? null,
    shareRateNumerator: vault.shareRateNumerator,
    shareRateDenominator: vault.shareRateDenominator,
    pausedDeposit: vault.pausedDeposit,
    pausedRedeem: vault.pausedRedeem,
    observedAt: meta.observedAt,
    source: meta.source,
    blockHeight: meta.blockHeight ?? null,
    blockHash: meta.blockHash ?? null,
  };
}

/** Convert underlying sBTC assets into zsBTC shares. Always rounds down. */
export function sharesForAssets(
  assets: string,
  market: Pick<ZestVaultMarketEvidence, "shareRateNumerator" | "shareRateDenominator">,
): string {
  return mulDiv(
    parseQuantity(assets),
    parseQuantity(market.shareRateNumerator),
    parseQuantity(market.shareRateDenominator),
    "down",
  ).toString(10);
}

/** Convert zsBTC shares into underlying sBTC. Always rounds down. */
export function assetsForShares(
  shares: string,
  market: Pick<ZestVaultMarketEvidence, "shareRateNumerator" | "shareRateDenominator">,
): string {
  return mulDiv(
    parseQuantity(shares),
    parseQuantity(market.shareRateDenominator),
    parseQuantity(market.shareRateNumerator),
    "down",
  ).toString(10);
}

/**
 * Value a receipt balance without inventing a rate. When the share rate is missing the underlying
 * claim stays null — never guess, and never treat the receipt as a second sBTC balance.
 */
export function valueZestReceipt(
  shares: string,
  market: Pick<ZestVaultMarketEvidence, "shareRateNumerator" | "shareRateDenominator"> | null,
  network: StacksNetwork,
): ZestReceiptValuation {
  const vault = findContract("zest", "v0-vault-sbtc", network);
  const token = findContract("sbtc", "sbtc-token", network);
  const receiptAssetId = vault === undefined ? `zest:unavailable:${network}:zft` : `${vault.contractId}:zft`;
  const underlyingAssetId =
    token === undefined ? `sbtc:unavailable:${network}:sbtc-token` : `${token.contractId}:sbtc-token`;
  if (market === null) {
    return {
      receiptAssetId,
      receiptUnits: shares,
      underlyingAssetId,
      underlyingUnits: null,
      countsReceiptTowardPortfolio: false,
      note: "zsBTC is a receipt claim. Without a vault share rate its underlying value is unknown and must not be counted as sBTC.",
    };
  }
  return {
    receiptAssetId,
    receiptUnits: shares,
    underlyingAssetId,
    underlyingUnits: assetsForShares(shares, market),
    countsReceiptTowardPortfolio: false,
    note: "zsBTC is the claim on supplied sBTC. Portfolio totals count the underlying position once; the receipt is evidence only.",
  };
}

export function zestSupplyApr(interestRateBps: string | null): ZestSupplyApr {
  const meaning =
    "Zest v0-vault-sbtc get-interest-rate returns a supply rate in basis points (scale 4). Stacks Capital shows that protocol value as-is and does not annualise, compound, or invent APY.";
  if (interestRateBps === null) {
    return {
      rateBps: null,
      scale: ZEST_RATE_SCALE,
      meaning,
      rankingAllowed: false,
      projectedEarningsAllowed: false,
    };
  }
  return {
    rateBps: interestRateBps,
    scale: ZEST_RATE_SCALE,
    meaning,
    rankingAllowed: true,
    projectedEarningsAllowed: true,
  };
}

function remainingCapacity(market: ZestVaultMarketEvidence): string | null {
  try {
    const remaining = parseQuantity(market.capSupply) - parseQuantity(market.totalAssets);
    return remaining < 0n ? "0" : remaining.toString(10);
  } catch {
    return null;
  }
}

/**
 * Rebuild the earn lifecycle from market evidence, an optional canonical vault event, and the
 * current share balance. Reloads use the same transfer id and never permit a second broadcast.
 */
export function evaluateZestEarn(input: {
  intent: ZestEarnIntent;
  market: ZestVaultMarketEvidence | null;
  settlement: CanonicalVaultSettlement | null;
  shares: ObservedShareBalance | null;
  broadcastKnown: boolean;
}): ZestEarnLifecycle {
  const transferId = zestEarnTransferId(input.intent.network, input.intent.action, input.intent.idempotencyKey);
  const capability = capabilityFor(input.intent.action, input.intent.network, "zest");
  const vaultId = findContract("zest", "v0-vault-sbtc", input.intent.network)?.contractId ?? "unavailable";
  const warnings: string[] = [];
  const apr = zestSupplyApr(input.market?.interestRateBps ?? null);
  const valuation = valueZestReceipt(input.shares?.shareBalance ?? "0", input.market, input.intent.network);

  const baseMarket = {
    totalAssets: input.market?.totalAssets ?? "0",
    availableAssets: input.market?.availableAssets ?? null,
    capSupply: input.market?.capSupply ?? "0",
    remainingCapacity: input.market === null ? null : remainingCapacity(input.market),
    pausedDeposit: input.market?.pausedDeposit ?? false,
    pausedRedeem: input.market?.pausedRedeem ?? false,
    shareRate: {
      numerator: input.market?.shareRateNumerator ?? "1",
      denominator: input.market?.shareRateDenominator ?? "1",
    },
    observedAt: input.market?.observedAt ?? "",
    source: input.market?.source ?? "missing",
    blockHeight: input.market?.blockHeight ?? null,
    blockHash: input.market?.blockHash ?? null,
  };

  const expectedShares =
    input.intent.action === "supply"
      ? input.market === null
        ? input.intent.amount
        : sharesForAssets(input.intent.amount, input.market)
      : input.intent.amount;
  const expectedAssets =
    input.intent.action === "supply"
      ? input.intent.amount
      : input.market === null
        ? input.intent.minOut
        : assetsForShares(input.intent.amount, input.market);

  const expected = { assets: expectedAssets, shares: expectedShares, minOut: input.intent.minOut };

  const lifecycle = (
    state: ZestEarnState,
    nextAction: ZestEarnLifecycle["nextAction"],
    complete: boolean,
    extras: { warnings?: string[] } = {},
  ): ZestEarnLifecycle => ({
    transferId,
    action: input.intent.action,
    network: input.intent.network,
    state,
    complete,
    nextAction,
    broadcastAllowed: false,
    contracts: { vault: vaultId },
    market: baseMarket,
    apr,
    valuation,
    expected,
    observed: {
      stacksTxid: input.settlement?.stacksTxid ?? null,
      assetsMoved: input.settlement?.assetsMoved ?? null,
      sharesMoved: input.settlement?.sharesMoved ?? null,
      shareBalance: input.shares?.shareBalance ?? null,
      underlyingClaim: valuation.underlyingUnits,
    },
    warnings: [...warnings, ...(extras.warnings ?? [])],
  });

  if (input.intent.network !== "mainnet" || capability?.state !== "enabled") {
    return lifecycle("unavailable", "UNAVAILABLE", false, {
      warnings: [
        capability?.reason ??
          "Zest v0-vault-sbtc is not an enabled capability on this network. Stacks Capital does not substitute mainnet or invent a vault path.",
      ],
    });
  }

  if (input.market === null) {
    return lifecycle("unavailable", "UNAVAILABLE", false, {
      warnings: ["Vault market evidence is missing. Quotes and rankings stay fail-closed."],
    });
  }

  if (input.intent.action === "supply" && input.market.pausedDeposit) {
    return lifecycle("paused", "UNAVAILABLE", false, { warnings: ["Vault deposits are paused."] });
  }
  if (input.intent.action === "withdraw_supply" && input.market.pausedRedeem) {
    return lifecycle("paused", "UNAVAILABLE", false, { warnings: ["Vault redemptions are paused."] });
  }

  if (input.intent.action === "supply") {
    const remaining = remainingCapacity(input.market);
    if (remaining !== null && parseQuantity(input.intent.amount) > parseQuantity(remaining)) {
      return lifecycle("cap_blocked", "UNAVAILABLE", false, {
        warnings: [`Supply of ${input.intent.amount} would exceed remaining capacity ${remaining}.`],
      });
    }
  }

  if (parseQuantity(expectedShares) < parseQuantity(input.intent.minOut) && input.intent.action === "supply") {
    warnings.push("Previewed shares are below min-out; the wallet must not sign this quote.");
  }
  if (parseQuantity(expectedAssets) < parseQuantity(input.intent.minOut) && input.intent.action === "withdraw_supply") {
    warnings.push("Previewed assets are below min-out; the wallet must not sign this quote.");
  }

  if (input.settlement === null) {
    return lifecycle(
      input.broadcastKnown ? "submitted" : "awaiting_signature",
      input.broadcastKnown ? "WAIT" : "SIGN",
      false,
    );
  }

  if (!input.settlement.canonical) {
    return lifecycle("confirming", "WAIT", false, {
      warnings: ["Vault settlement is not yet on a canonical Stacks block."],
    });
  }

  const expectedKind = input.intent.action === "supply" ? "zest_deposit" : "zest_redeem";
  const mismatches: string[] = [];
  if (input.settlement.kind !== expectedKind) {
    mismatches.push(`expected ${expectedKind}, observed ${input.settlement.kind}`);
  }
  if (input.settlement.owner !== input.intent.owner && input.settlement.owner !== input.intent.recipient) {
    mismatches.push("settlement owner does not match the intent owner or recipient");
  }
  if (input.intent.action === "supply") {
    if (input.settlement.assetsMoved !== input.intent.amount) {
      mismatches.push(`assets moved ${input.settlement.assetsMoved} !== supplied ${input.intent.amount}`);
    }
    if (input.settlement.sharesMoved !== expected.shares) {
      mismatches.push(`shares minted ${input.settlement.sharesMoved} !== preview ${expected.shares}`);
    }
  } else {
    if (parseQuantity(input.settlement.assetsMoved) < parseQuantity(input.intent.minOut)) {
      mismatches.push(`redeemed assets ${input.settlement.assetsMoved} are below min-out ${input.intent.minOut}`);
    }
    if (input.settlement.sharesMoved !== input.intent.amount) {
      mismatches.push(`shares redeemed ${input.settlement.sharesMoved} !== requested ${input.intent.amount}`);
    }
  }

  if (mismatches.length > 0) {
    return lifecycle("reconciliation_failed", "CONTACT_SUPPORT", false, {
      warnings: mismatches,
    });
  }

  return lifecycle("reconciled", "COMPLETE", true);
}
