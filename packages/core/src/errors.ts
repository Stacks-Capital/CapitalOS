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
  if (!("code" in error) || !("message" in error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !(code in ERROR_CLASS)) return false;
  const typed = code as ErrorCode;
  const cls = "class" in error ? (error as { class: unknown }).class : (error as { errorClass?: unknown }).errorClass;
  return cls === ERROR_CLASS[typed] && typeof (error as { message?: unknown }).message === "string";
}

function classOf(error: CapitalError | { class?: ErrorClass; errorClass?: ErrorClass }): ErrorClass | undefined {
  return "class" in error ? error.class : error.errorClass;
}

export function isRetryableRead(error: CapitalError | { class?: ErrorClass; errorClass?: ErrorClass }): boolean {
  return classOf(error) === "retryable_read";
}

export function isRequoteError(error: CapitalError | { class?: ErrorClass; errorClass?: ErrorClass }): boolean {
  return classOf(error) === "requote";
}

export function isUserActionError(error: CapitalError | { class?: ErrorClass; errorClass?: ErrorClass }): boolean {
  return classOf(error) === "user_action";
}

export function isInvestigationError(error: CapitalError | { class?: ErrorClass; errorClass?: ErrorClass }): boolean {
  return classOf(error) === "investigation";
}

export function isFinancialError(error: unknown): error is CapitalError {
  return isCapitalError(error);
}

export function allowsWriteRetry(
  error: CapitalError | { code: ErrorCode; class?: ErrorClass; errorClass?: ErrorClass },
): boolean {
  return error.code !== "BROADCAST_UNKNOWN" && classOf(error) !== "investigation";
}
