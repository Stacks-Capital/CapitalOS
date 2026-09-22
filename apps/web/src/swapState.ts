import type { PlanWire, QuoteWire, StacksNetwork } from "@stacks-capital/sdk";

export const REFRESH_MARGIN_SECONDS = 15;

export type SwapRouteLeg = { contractId: string; functionName: string };

export type SwapViewLike = {
  route: SwapRouteLeg[];
  sending: string;
  expectedReceived: string;
  minimumReceived: string | null;
  impactBps: string | null;
  impactNote: string | null;
  expiresInSeconds: number;
  expired: boolean;
  needsRefresh: boolean;
  warnings: string[];
};

export const CANONICAL_SWAP_ASSETS = {
  sbtc: {
    symbol: "sBTC",
    name: "Stacks Bitcoin",
    decimals: 8,
    mainnetContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    testnetContract: "SN3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    feedKey: "BTC/USD",
  },
  usdcx: {
    symbol: "USDCx",
    name: "Bridged USDC",
    decimals: 6,
    mainnetContract: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token",
    testnetContract: "ST120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token",
    feedKey: "USDC/USD",
  },
  stx: {
    symbol: "STX",
    name: "Stacks Token",
    decimals: 6,
    mainnetContract: "native:stacks:stx",
    testnetContract: "native:stacks:stx",
    feedKey: "STX/USD",
  },
} as const;

export type SwapAssetKey = keyof typeof CANONICAL_SWAP_ASSETS;

/**
 * Converts a human-readable decimal amount (e.g. "0.015") into exact integer base units (e.g. "1500000").
 * Avoids IEEE-754 floating-point inaccuracies by operating on strings.
 */
export function toBaseUnits(displayAmount: string, decimals: number): string {
  const trimmed = displayAmount.trim();
  if (!trimmed || trimmed === "0" || trimmed === ".") return "0";
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal number format: "${displayAmount}"`);
  }

  const parts = trimmed.split(".");
  const intPart = parts[0] ?? "0";
  const fracPart = parts[1] ?? "";

  const paddedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const combined = `${intPart}${paddedFrac}`.replace(/^0+/, "");
  return combined === "" ? "0" : combined;
}

/**
 * Converts raw integer base units (e.g. "1500000") into a human-readable decimal string (e.g. "0.015").
 */
export function fromBaseUnits(baseUnits: string, decimals: number): string {
  const trimmed = baseUnits.trim().replace(/^0+/, "");
  if (!trimmed) return "0";

  if (trimmed.length <= decimals) {
    const frac = trimmed.padStart(decimals, "0");
    const strippedFrac = frac.replace(/0+$/, "");
    return strippedFrac === "" ? "0" : `0.${strippedFrac}`;
  }

  const intPart = trimmed.slice(0, trimmed.length - decimals);
  const fracPart = trimmed.slice(trimmed.length - decimals).replace(/0+$/, "");

  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}

export type AssetReconciliationResult = {
  reconciled: boolean;
  sentSymbol: string;
  sentDecimals: number;
  receivedSymbol: string;
  receivedDecimals: number;
  reason?: string;
};

/**
 * Reconciles swap input and output asset identifiers and decimal precision against canonical definitions.
 * Acceptance Evidence 3: Asset identifiers and decimals reconcile exactly.
 */
export function reconcileSwapAssets(
  quote: {
    input: Array<{ asset: string; quantity: string }>;
    expectedOutput: Array<{ asset: string; quantity: string }>;
  },
  network: StacksNetwork,
): AssetReconciliationResult {
  const input = quote.input[0];
  const output = quote.expectedOutput[0];

  if (!input || !output) {
    return {
      reconciled: false,
      sentSymbol: "unknown",
      sentDecimals: 0,
      receivedSymbol: "unknown",
      receivedDecimals: 0,
      reason: "Quote is missing input or expected output asset definitions.",
    };
  }

  const resolveAsset = (assetId: string) => {
    const lower = assetId.toLowerCase();
    if (lower.includes("sbtc")) return CANONICAL_SWAP_ASSETS.sbtc;
    if (lower.includes("usdcx") || lower.includes("usdc")) return CANONICAL_SWAP_ASSETS.usdcx;
    if (lower.includes("stx")) return CANONICAL_SWAP_ASSETS.stx;
    return null;
  };

  const sentInfo = resolveAsset(input.asset);
  const receivedInfo = resolveAsset(output.asset);

  if (!sentInfo || !receivedInfo) {
    return {
      reconciled: false,
      sentSymbol: sentInfo?.symbol ?? "unknown",
      sentDecimals: sentInfo?.decimals ?? 0,
      receivedSymbol: receivedInfo?.symbol ?? "unknown",
      receivedDecimals: receivedInfo?.decimals ?? 0,
      reason: `Unrecognized asset identifier in route: input="${input.asset}", output="${output.asset}"`,
    };
  }

  // Network contract verification
  const expectedSentContract = network === "mainnet" ? sentInfo.mainnetContract : sentInfo.testnetContract;
  const expectedReceivedContract = network === "mainnet" ? receivedInfo.mainnetContract : receivedInfo.testnetContract;

  if (!input.asset.includes(expectedSentContract) && !expectedSentContract.includes("native")) {
    return {
      reconciled: false,
      sentSymbol: sentInfo.symbol,
      sentDecimals: sentInfo.decimals,
      receivedSymbol: receivedInfo.symbol,
      receivedDecimals: receivedInfo.decimals,
      reason: `Input asset contract "${input.asset}" does not match canonical deployment "${expectedSentContract}" for ${network}.`,
    };
  }

  if (!output.asset.includes(expectedReceivedContract) && !expectedReceivedContract.includes("native")) {
    return {
      reconciled: false,
      sentSymbol: sentInfo.symbol,
      sentDecimals: sentInfo.decimals,
      receivedSymbol: receivedInfo.symbol,
      receivedDecimals: receivedInfo.decimals,
      reason: `Output asset contract "${output.asset}" does not match canonical deployment "${expectedReceivedContract}" for ${network}.`,
    };
  }

  return {
    reconciled: true,
    sentSymbol: sentInfo.symbol,
    sentDecimals: sentInfo.decimals,
    receivedSymbol: receivedInfo.symbol,
    receivedDecimals: receivedInfo.decimals,
  };
}

export type MinimumOutputEnforcement = {
  enforced: boolean;
  minOutQuantity: string | null;
  minOutAsset: string | null;
  onchainArgVerified: boolean;
  postConditionVerified: boolean;
  denyModeVerified: boolean;
  reason?: string;
};

/**
 * Validates that minimum output is strictly enforced onchain in the plan contract call and post-conditions.
 * Acceptance Evidence 2: Minimum output is enforced by the plan/contract call.
 */
export function verifyMinimumOutputEnforcement(quote: QuoteWire, plan: PlanWire): MinimumOutputEnforcement {
  if (!quote.minimumOutput || !quote.minimumOutput.quantity || quote.minimumOutput.quantity === "0") {
    return {
      enforced: false,
      minOutQuantity: null,
      minOutAsset: null,
      onchainArgVerified: false,
      postConditionVerified: false,
      denyModeVerified: false,
      reason: "Quote lacks guaranteed minimumOutput floor.",
    };
  }

  const expectedMinQty = quote.minimumOutput.quantity;
  const minOutAsset = quote.minimumOutput.asset;

  // Search for the router swap step
  const swapStep = plan.steps.find(
    (step) =>
      step.payload.kind === "stacks_contract_call" && step.payload.functionName.toLowerCase().startsWith("swap-"),
  );

  if (!swapStep || swapStep.payload.kind !== "stacks_contract_call") {
    return {
      enforced: false,
      minOutQuantity: expectedMinQty,
      minOutAsset,
      onchainArgVerified: false,
      postConditionVerified: false,
      denyModeVerified: false,
      reason: "Plan does not contain an executable swap contract call step.",
    };
  }

  const payload = swapStep.payload;

  // 1. Check onchain function argument (e.g. minOut arg)
  const args = payload.functionArgs ?? [];
  const minOutArg = args.find((arg) => arg.type === "uint" && String(arg.value) === expectedMinQty);
  const onchainArgVerified = minOutArg !== undefined;

  // 2. Check deny-mode post condition protecting min-out received
  const postConditions = payload.postConditions ?? [];
  const minReceivePc = postConditions.find((pc) => pc.mode === "receive_gte" && pc.amount.quantity === expectedMinQty);
  const postConditionVerified = minReceivePc !== undefined;

  // 3. Deny mode verification
  const denyModeVerified = payload.postConditionMode === "deny";

  const enforced = onchainArgVerified && postConditionVerified && denyModeVerified;

  return {
    enforced,
    minOutQuantity: expectedMinQty,
    minOutAsset,
    onchainArgVerified,
    postConditionVerified,
    denyModeVerified,
    ...(enforced
      ? {}
      : {
          reason: `Enforcement check failed: onchainArg=${onchainArgVerified}, postCondition=${postConditionVerified}, denyMode=${denyModeVerified}`,
        }),
  };
}

export type PriceImpactTier = "low" | "medium" | "high" | "unknown";

/**
 * Classifies basis points of price impact into visual risk tiers.
 * < 100 bps (1%): low
 * 100 - 300 bps (1% - 3%): medium
 * > 300 bps (> 3%): high
 */
export function priceImpactCategory(impactBps: string | null): PriceImpactTier {
  if (impactBps === null) return "unknown";
  try {
    const val = BigInt(impactBps);
    if (val < 100n) return "low";
    if (val <= 300n) return "medium";
    return "high";
  } catch {
    return "unknown";
  }
}

/**
 * Strict guard checking whether a quote is legally signable right now.
 * Acceptance Evidence 1: Expired quotes cannot reach signing.
 */
export function isQuoteSignable(
  view: SwapViewLike | null,
  quoted: { quote: { expiresAt: string; executable: boolean; [key: string]: unknown }; [key: string]: unknown } | null,
  now: Date,
): boolean {
  if (!view || !quoted) return false;
  if (!quoted.quote.executable) return false;
  if (view.expired || view.needsRefresh) return false;
  if (!view.minimumReceived) return false;

  const expiryMs = new Date(quoted.quote.expiresAt).getTime();
  const nowMs = now.getTime();
  const remainingSeconds = Math.floor((expiryMs - nowMs) / 1000);

  // Hard stop if expired or within refresh margin (<= 15 seconds)
  if (remainingSeconds <= REFRESH_MARGIN_SECONDS) return false;

  return true;
}

/**
 * Formats a remaining seconds countdown into a human-readable status badge.
 */
export function formatExpiryCountdown(expiresInSeconds: number): {
  text: string;
  status: "valid" | "warning" | "expired";
} {
  if (expiresInSeconds <= 0) {
    return { text: "Quote expired", status: "expired" };
  }
  if (expiresInSeconds <= REFRESH_MARGIN_SECONDS) {
    return { text: `Expires in ${expiresInSeconds}s (Requote required)`, status: "warning" };
  }
  return { text: `Quote valid for ${expiresInSeconds}s`, status: "valid" };
}
