import type { OracleQuoteView, QuotedPlan } from "@stacks-capital/client";

/** A quote must have at least this long left, or it is refreshed before the wallet is asked. */
export const REFRESH_MARGIN_SECONDS = 15;

export type RouteLeg = { contractId: string; functionName: string };

export type SwapView = {
  route: RouteLeg[];
  sending: string;
  expectedReceived: string;
  minimumReceived: string | null;
  /** Basis points away from the oracle price. Null when a price is missing, never zero. */
  impactBps: string | null;
  impactNote: string | null;
  expiresInSeconds: number;
  expired: boolean;
  /** True when the quote is too close to expiry to be approved safely. */
  needsRefresh: boolean;
  warnings: string[];
};

function priceOf(prices: OracleQuoteView[], feedKey: string): { price: bigint; scale: bigint } | null {
  const found = prices.find((entry) => entry.feedKey === feedKey);
  if (found === undefined || found.price === null || found.stale) return null;
  return { price: BigInt(found.price), scale: BigInt(found.scale) };
}

/**
 * How far the quoted rate sits from the oracle rate, in basis points. Positive means worse for the user.
 * Returns null when either price is missing or stale, because an impact against a guess is worse than none.
 */
export function priceImpactBps(input: {
  sentQuantity: bigint;
  sentDecimals: bigint;
  receivedQuantity: bigint;
  receivedDecimals: bigint;
  sentPrice: { price: bigint; scale: bigint } | null;
  receivedPrice: { price: bigint; scale: bigint } | null;
}): bigint | null {
  if (input.sentPrice === null || input.receivedPrice === null) return null;
  if (input.sentQuantity <= 0n || input.receivedQuantity <= 0n) return null;

  const scale = 10n ** 18n;
  const sentValue =
    (input.sentQuantity * input.sentPrice.price * scale) / (10n ** input.sentDecimals * 10n ** input.sentPrice.scale);
  const receivedValue =
    (input.receivedQuantity * input.receivedPrice.price * scale) /
    (10n ** input.receivedDecimals * 10n ** input.receivedPrice.scale);
  if (sentValue === 0n) return null;
  return ((sentValue - receivedValue) * 10_000n) / sentValue;
}

export type SwapAssets = { sentFeed: string; receivedFeed: string; sentDecimals: number; receivedDecimals: number };

export function swapView(quoted: QuotedPlan, prices: OracleQuoteView[], assets: SwapAssets, now: Date): SwapView {
  const quote = quoted.quote;
  const sent = quote.input[0];
  const received = quote.expectedOutput[0];
  const expiresInSeconds = Math.floor((new Date(quote.expiresAt).getTime() - now.getTime()) / 1000);

  const impactBps =
    sent === undefined || received === undefined
      ? null
      : priceImpactBps({
          sentQuantity: BigInt(sent.quantity),
          sentDecimals: BigInt(assets.sentDecimals),
          receivedQuantity: BigInt(received.quantity),
          receivedDecimals: BigInt(assets.receivedDecimals),
          sentPrice: priceOf(prices, assets.sentFeed),
          receivedPrice: priceOf(prices, assets.receivedFeed),
        });

  return {
    route: quoted.plan.steps.map((step) => ({
      contractId: String(step.payload.contractId ?? "unknown"),
      functionName: String(step.payload.functionName ?? "unknown"),
    })),
    sending: sent === undefined ? "unknown" : `${sent.quantity} ${sent.asset}`,
    expectedReceived: received === undefined ? "unknown" : `${received.quantity} ${received.asset}`,
    minimumReceived:
      quote.minimumOutput === undefined ? null : `${quote.minimumOutput.quantity} ${quote.minimumOutput.asset}`,
    impactBps: impactBps === null ? null : impactBps.toString(10),
    impactNote: impactBps === null ? "Price impact needs a fresh price for both sides, and one is missing." : null,
    expiresInSeconds: Math.max(0, expiresInSeconds),
    expired: expiresInSeconds <= 0,
    // Approving takes time, so a quote about to expire is refreshed first rather than sent to the wallet.
    needsRefresh: expiresInSeconds <= REFRESH_MARGIN_SECONDS,
    warnings: quote.warnings,
  };
}

/** A swap can only be sent to the wallet with a quote that is executable and comfortably unexpired. */
export function canApprove(view: SwapView, quoted: QuotedPlan): boolean {
  return quoted.quote.executable && !view.expired && !view.needsRefresh && view.minimumReceived !== null;
}
