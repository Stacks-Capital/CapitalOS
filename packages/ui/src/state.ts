import { CapitalApiError, CapitalTransportError, type ResponseContext } from "@stacks-capital/client";

/** What a panel shows. "unavailable" is a real answer: the data has no source yet. */
export type PanelState =
  | { kind: "loading" }
  | { kind: "ready"; stale: boolean; warnings: string[]; observedAt: string | null }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string; canRetry: boolean; requestId: string | null };

export type QueryLike<T> = { status: string; data: T | undefined; error: unknown };

// Panels whose endpoint does not exist yet. Naming the task keeps the screen honest about why.
export const UNAVAILABLE = {
  balances: "Wallet balances need a balances endpoint, which is not built yet (I11 projects them).",
  positions: "Positions need a positions endpoint, which is not built yet (I11 decodes them).",
  quotes: "Quotes need the quote endpoint, which is not built yet.",
} as const;

export function messageFor(error: unknown): { message: string; canRetry: boolean; requestId: string | null } {
  if (error instanceof CapitalApiError) {
    const canRetry = error.errorClass === "retryable_read";
    const messages: Record<string, string> = {
      UNAUTHORIZED: "Your session has expired. Sign in again.",
      FORBIDDEN: "This app is not allowed to read that.",
      NOT_FOUND: "Not found.",
      RATE_LIMITED: `Too many requests. Try again in ${error.retryAfter ?? 60} seconds.`,
      TEMPORARY_UNAVAILABLE: "Capital OS is busy. Try again shortly.",
      NETWORK_MISMATCH: "That belongs to another network.",
    };
    return { message: messages[error.code] ?? error.message, canRetry, requestId: error.requestId };
  }
  if (error instanceof CapitalTransportError) {
    const messages: Record<string, string> = {
      timeout: "The request took too long. Try again.",
      aborted: "Cancelled.",
      network: "Cannot reach Capital OS. Check your connection.",
      protocol: "Capital OS answered something this app does not understand.",
    };
    return {
      message: messages[error.kind] ?? "Something went wrong.",
      canRetry: error.kind !== "aborted",
      requestId: null,
    };
  }
  return { message: "Something went wrong.", canRetry: false, requestId: null };
}

export function panelState<T>(query: QueryLike<T>, context?: ResponseContext | undefined): PanelState {
  if (query.status === "error" && query.data === undefined) {
    const described = messageFor(query.error);
    return { kind: "error", ...described };
  }
  if (query.data === undefined) return { kind: "loading" };
  // Data that failed to refresh is still shown, marked stale, rather than replaced by an error.
  const staleFromError = query.status === "error";
  return {
    kind: "ready",
    stale: staleFromError || context?.stale === true,
    warnings: staleFromError
      ? [messageFor(query.error).message, ...(context?.warnings ?? [])]
      : (context?.warnings ?? []),
    observedAt: context?.observedAt ?? null,
  };
}
