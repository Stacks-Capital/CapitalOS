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

/** The API answered with an error body. */
export class CapitalApiError extends Error {
  override readonly name = "CapitalApiError";
  readonly code: ApiErrorCode;
  readonly errorClass: ErrorClass;
  readonly status: number;
  readonly requestId: string;
  readonly retryAfter: number | undefined;

  constructor(input: { code: ApiErrorCode; message: string; status: number; requestId: string; retryAfter?: number }) {
    super(input.message);
    this.code = input.code;
    this.errorClass = errorClassOf(input.code);
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryAfter = input.retryAfter;
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

// A cancelled request is never retried: the caller asked for it to stop.
export function isRetryable(error: unknown): boolean {
  if (error instanceof CapitalTransportError) return error.kind === "timeout" || error.kind === "network";
  if (error instanceof CapitalApiError) return error.errorClass === "retryable_read";
  return false;
}
