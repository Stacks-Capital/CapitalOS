import { ERROR_CLASS, type ErrorClass, type ErrorCode } from "@stacks-capital/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SCHEMA_VERSION } from "./schemas.ts";

// Core's error contract plus the transport errors every HTTP API needs.
export type ApiErrorCode =
  | ErrorCode
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "TEMPORARY_UNAVAILABLE"
  | "INTERNAL";

const STATUS: Partial<Record<ApiErrorCode, ContentfulStatusCode>> = {
  INVALID_REQUEST: 400,
  NETWORK_MISMATCH: 400,
  PLAN_INVALID: 400,
  CAP_REACHED: 400,
  ORACLE_STALE: 400,
  QUORUM_DISAGREEMENT: 409,
  INSUFFICIENT_BALANCE: 400,
  UNSUPPORTED_ACTION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CAPABILITY_DISABLED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  PROVIDER_TIMEOUT: 503,
  TEMPORARY_UNAVAILABLE: 503,
};

const BY_CLASS: Partial<Record<ErrorClass, ContentfulStatusCode>> = {
  user_action: 400,
  // The caller has to ask for a new quote before trying again.
  requote: 409,
  retryable_read: 503,
  investigation: 500,
};

export const ACTIONABLE_REMEDIATIONS: Record<string, string> = {
  INVALID_REQUEST: "Fix the request. The message names the field.",
  UNAUTHORIZED: "Sign in again for a session, or check the API key.",
  FORBIDDEN: "Use a caller with the right scope. Never send an API key from a browser.",
  NOT_FOUND: "Check the id and the network.",
  TEMPORARY_UNAVAILABLE: "Retry after a short wait. The client does this for reads.",
  INTERNAL: "Retry once, then contact support with the request id.",
  PROVIDER_TIMEOUT: "Retry. The client does this for reads.",
  RATE_LIMITED: "Wait for the number of seconds in retryAfter.",
  QUOTE_EXPIRED: "Ask for a new quote.",
  CAP_REACHED: "Ask for a new quote with a smaller amount, or wait for capacity.",
  ORACLE_STALE: "Ask for a new quote once the price has updated.",
  QUORUM_DISAGREEMENT: "Ask for a new quote once oracle price sources converge.",
  USER_REJECTED: "Nothing to fix. Offer to ask the wallet again.",
  INSUFFICIENT_BALANCE: "Lower the amount or fund the wallet.",
  NETWORK_MISMATCH: "Switch the wallet or the request to the same network.",
  UNSUPPORTED_WALLET: "Use a supported wallet (Leather or Xverse).",
  UNSUPPORTED_ACTION: "Pick an action the market lists in /v1/markets.",
  PLAN_INVALID: "Ask for a new quote and plan.",
  CAPABILITY_DISABLED: "Select an enabled market capability or action.",
  BROADCAST_UNKNOWN: "Never resubmit. Check the chain for the transaction, then contact support with the workflow id.",
  REORG_DETECTED: "Wait for chain reorganization to settle and resume workflow.",
  RECONCILIATION_MISMATCH: "Contact support with the workflow id. Do not act on the balance shown.",
  UNCLASSIFIED: "Contact support with the request id.",
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly retryAfter: number | undefined;

  constructor(code: ApiErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }

  get status(): ContentfulStatusCode {
    // Codes without their own status follow core's class: what the caller can do decides the status.
    return STATUS[this.code] ?? BY_CLASS[ERROR_CLASS[this.code as ErrorCode]] ?? 500;
  }
}

export function errorBody(
  requestId: string,
  code: ApiErrorCode,
  message: string,
  retryAfter?: number,
  customAction?: string,
) {
  const action = customAction ?? ACTIONABLE_REMEDIATIONS[code] ?? "Inspect request parameters and retry.";
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    error: {
      code,
      message,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      action,
    },
  } as const;
}
