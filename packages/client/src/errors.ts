import { ERROR_CLASS, type ErrorClass, type ErrorCode } from "@stacks-capital/core";

// The API's error contract: core's codes plus the transport codes (docs/engineering/api.md).
export type ApiErrorCode =
  | ErrorCode
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "TEMPORARY_UNAVAILABLE"
  | "INTERNAL";

const TRANSPORT_CLASS: Record<string, ErrorClass> = {
  INVALID_REQUEST: "user_action",
  NOT_FOUND: "user_action",
  UNAUTHORIZED: "user_action",
  FORBIDDEN: "user_action",
  TEMPORARY_UNAVAILABLE: "retryable_read",
  INTERNAL: "investigation",
};

export function errorClassOf(code: string): ErrorClass {
  return ERROR_CLASS[code as ErrorCode] ?? TRANSPORT_CLASS[code] ?? "investigation";
}

export function isFinancialErrorCode(code: string): code is ErrorCode {
  return code in ERROR_CLASS;
}

/** The API answered with an error body. */
export class CapitalApiError extends Error {
  override readonly name: string = "CapitalApiError";
  readonly code: ApiErrorCode;
  readonly errorClass: ErrorClass;
  readonly status: number;
  readonly requestId: string;
  readonly retryAfter: number | undefined;
  readonly action: string | undefined;

  constructor(input: {
    code: ApiErrorCode;
    message: string;
    status: number;
    requestId: string;
    retryAfter?: number | undefined;
    action?: string | undefined;
  }) {
    super(input.message);
    this.code = input.code;
    this.errorClass = errorClassOf(input.code);
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryAfter = input.retryAfter;
    this.action = input.action;
  }
}

/**
 * Subclass of CapitalApiError for financial quote, execution, valuation, and balance errors.
 * Provides direct ergonomic classifications for partner applications.
 */
export class CapitalFinancialError extends CapitalApiError {
  override readonly name = "CapitalFinancialError";

  /** True if this error indicates the client should fetch a new quote before proceeding. */
  isRequote(): boolean {
    return this.errorClass === "requote";
  }

  /** True if this error requires user intervention (e.g. approve in wallet, deposit balance). */
  isUserAction(): boolean {
    return this.errorClass === "user_action";
  }

  /** True if this error represents an ambiguous on-chain state requiring manual or backend investigation. */
  isInvestigation(): boolean {
    return this.errorClass === "investigation";
  }

  /** True if this error is transient and safe to retry automatically without side effects. */
  isRetryableRead(): boolean {
    return this.errorClass === "retryable_read";
  }
}

export type TransportKind = "timeout" | "aborted" | "network" | "protocol";

/** The request never produced an error body: it timed out, was cancelled, failed, or answered something unexpected. */
export class CapitalTransportError extends Error {
  override readonly name = "CapitalTransportError";
  readonly kind: TransportKind;

  constructor(kind: TransportKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

/** The client was built in a way that would leak a secret or cannot work. Thrown before any request. */
export class CapitalConfigError extends Error {
  override readonly name = "CapitalConfigError";
}

export function isCapitalApiError(error: unknown): error is CapitalApiError {
  return error instanceof CapitalApiError;
}

export function isCapitalFinancialError(error: unknown): error is CapitalFinancialError {
  return error instanceof CapitalFinancialError;
}

export function isCapitalTransportError(error: unknown): error is CapitalTransportError {
  return error instanceof CapitalTransportError;
}

export function isCapitalConfigError(error: unknown): error is CapitalConfigError {
  return error instanceof CapitalConfigError;
}

// A cancelled request is never retried: the caller asked for it to stop.
export function isRetryable(error: unknown): boolean {
  if (error instanceof CapitalTransportError) return error.kind === "timeout" || error.kind === "network";
  if (error instanceof CapitalApiError) return error.errorClass === "retryable_read";
  return false;
}
