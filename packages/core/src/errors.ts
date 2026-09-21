export type ErrorClass = "retryable_read" | "requote" | "user_action" | "investigation";

export type ErrorCode =
  | "PROVIDER_TIMEOUT"
  | "RATE_LIMITED"
  | "QUOTE_EXPIRED"
  | "CAP_REACHED"
  | "ORACLE_STALE"
  | "QUORUM_DISAGREEMENT"
  | "USER_REJECTED"
  | "INSUFFICIENT_BALANCE"
  | "NETWORK_MISMATCH"
  | "UNSUPPORTED_WALLET"
  | "UNSUPPORTED_ACTION"
  | "PLAN_INVALID"
  | "CAPABILITY_DISABLED"
  | "BROADCAST_UNKNOWN"
  | "REORG_DETECTED"
  | "RECONCILIATION_MISMATCH"
  | "UNCLASSIFIED";

export const ERROR_CLASS: Readonly<Record<ErrorCode, ErrorClass>> = {
  PROVIDER_TIMEOUT: "retryable_read",
  RATE_LIMITED: "retryable_read",
  QUOTE_EXPIRED: "requote",
  CAP_REACHED: "requote",
  ORACLE_STALE: "requote",
  QUORUM_DISAGREEMENT: "requote",
  USER_REJECTED: "user_action",
  INSUFFICIENT_BALANCE: "user_action",
  NETWORK_MISMATCH: "user_action",
  UNSUPPORTED_WALLET: "user_action",
  UNSUPPORTED_ACTION: "user_action",
  PLAN_INVALID: "user_action",
  CAPABILITY_DISABLED: "user_action",
  BROADCAST_UNKNOWN: "investigation",
  REORG_DETECTED: "investigation",
  RECONCILIATION_MISMATCH: "investigation",
  UNCLASSIFIED: "investigation",
};

export type CapitalError = {
  code: ErrorCode;
  class: ErrorClass;
  message: string;
};

export function capitalError(code: ErrorCode, message: string): CapitalError {
  return { code, class: ERROR_CLASS[code], message };
}

export function isCapitalError(error: unknown): error is CapitalError {
  if (typeof error !== "object" || error === null) return false;
  if (!("code" in error) || !("class" in error) || !("message" in error)) return false;
  const code = error.code;
  if (typeof code !== "string" || !(code in ERROR_CLASS)) return false;
  const typed = code as ErrorCode;
  return error.class === ERROR_CLASS[typed] && typeof error.message === "string";
}

export function isRetryableRead(error: CapitalError): boolean {
  return error.class === "retryable_read";
}

export function allowsWriteRetry(error: CapitalError): boolean {
  return error.code !== "BROADCAST_UNKNOWN" && error.class !== "investigation";
}
