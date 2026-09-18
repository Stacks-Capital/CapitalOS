import type { ErrorCode } from "@stacks-capital/core";
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
  QUOTE_EXPIRED: 400,
  PLAN_INVALID: 400,
  CAP_REACHED: 400,
  ORACLE_STALE: 400,
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

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly retryAfter: number | undefined;

  constructor(code: ApiErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }

  get status(): ContentfulStatusCode {
    return STATUS[this.code] ?? 500;
  }
}

export function errorBody(requestId: string, code: ApiErrorCode, message: string, retryAfter?: number) {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    error: retryAfter === undefined ? { code, message } : { code, message, retryAfter },
  } as const;
}
