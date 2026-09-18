import type { StacksNetwork } from "@stacks-capital/core";
import { type ApiErrorCode, CapitalApiError, CapitalTransportError, isRetryable } from "./errors.ts";
import type { ResponseContext } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export type RetryPolicy = {
  /** Total attempts for a safe read, including the first one. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A retry-after longer than this is not waited out; the error is thrown instead. */
  maxRetryAfterMs: number;
};

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000, maxRetryAfterMs: 10_000 };
export const DEFAULT_TIMEOUT_MS = 15_000;

export type Transport = {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  retry: RetryPolicy;
  /** Seams so tests do not wait in real time. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  jitter: () => number;
};

export type RequestSpec = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Only safe reads are retried. A POST is sent at most once. */
  retry: boolean;
};

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CapitalTransportError("aborted", "Request was cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CapitalTransportError("aborted", "Request was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildUrl(baseUrl: string, spec: RequestSpec): string {
  const url = new URL(`${baseUrl}${spec.path}`);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function readContext(body: Record<string, unknown>): ResponseContext {
  const context = (body.context ?? {}) as Record<string, unknown>;
  const network = String(body.network ?? "").replace(/^stacks:/, "") as StacksNetwork;
  if (network !== "mainnet" && network !== "testnet") {
    throw new CapitalTransportError("protocol", `Response names an unknown network: ${String(body.network)}`);
  }
  const point: ResponseContext = {
    requestId: String(body.requestId ?? ""),
    network,
    observedAt: String(context.observedAt ?? ""),
    stale: context.stale === true,
    warnings: Array.isArray(context.warnings) ? context.warnings.map(String) : [],
  };
  if (typeof context.blockHeight === "number") point.blockHeight = context.blockHeight;
  if (typeof context.blockHash === "string") point.blockHash = context.blockHash;
  return point;
}

function toApiError(status: number, requestId: string, body: unknown): CapitalApiError | CapitalTransportError {
  const error = (body as { error?: { code?: unknown; message?: unknown; retryAfter?: unknown } } | null)?.error;
  if (error === undefined || typeof error.code !== "string") {
    return new CapitalTransportError("protocol", `HTTP ${status} without an error body`);
  }
  return new CapitalApiError({
    code: error.code as ApiErrorCode,
    message: typeof error.message === "string" ? error.message : `HTTP ${status}`,
    status,
    requestId,
    ...(typeof error.retryAfter === "number" ? { retryAfter: error.retryAfter } : {}),
  });
}

async function attempt<T>(transport: Transport, spec: RequestSpec): Promise<{ data: T; context: ResponseContext }> {
  const timeout = AbortSignal.timeout(transport.timeoutMs);
  const signal = spec.signal === undefined ? timeout : AbortSignal.any([spec.signal, timeout]);

  let response: Response;
  try {
    response = await transport.fetch(buildUrl(transport.baseUrl, spec), {
      method: spec.method,
      headers: spec.body === undefined ? spec.headers : { ...spec.headers, "content-type": "application/json" },
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      signal,
    });
  } catch (cause) {
    if (spec.signal?.aborted === true) throw new CapitalTransportError("aborted", "Request was cancelled", { cause });
    if (timeout.aborted) {
      throw new CapitalTransportError("timeout", `Request timed out after ${transport.timeoutMs}ms`, { cause });
    }
    throw new CapitalTransportError("network", "Request could not be sent", { cause });
  }

  const requestId = response.headers.get("x-request-id") ?? "";
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new CapitalTransportError("protocol", `HTTP ${response.status} with an unreadable body`, { cause });
  }

  if (!response.ok) {
    const parsed = body as { requestId?: unknown };
    throw toApiError(response.status, typeof parsed?.requestId === "string" ? parsed.requestId : requestId, body);
  }

  const envelope = body as Record<string, unknown>;
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new CapitalTransportError("protocol", `Unsupported schema version: ${String(envelope.schemaVersion)}`);
  }
  if (envelope.data === undefined) throw new CapitalTransportError("protocol", "Response has no data");
  return { data: envelope.data as T, context: readContext(envelope) };
}

function delayFor(transport: Transport, error: unknown, index: number): number {
  const retryAfterMs = error instanceof CapitalApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : 0;
  if (retryAfterMs > 0) return retryAfterMs;
  const backoff = Math.min(transport.retry.baseDelayMs * 2 ** index, transport.retry.maxDelayMs);
  return backoff + Math.floor(transport.jitter() * transport.retry.baseDelayMs);
}

export async function send<T>(transport: Transport, spec: RequestSpec): Promise<{ data: T; context: ResponseContext }> {
  const attempts = spec.retry ? Math.max(1, transport.retry.attempts) : 1;
  let lastError: unknown;

  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt<T>(transport, spec);
    } catch (error) {
      lastError = error;
      const last = index === attempts - 1;
      if (last || !isRetryable(error) || spec.signal?.aborted === true) throw error;
      const delay = delayFor(transport, error, index);
      // Waiting longer than the caller would tolerate is worse than reporting the error.
      if (delay > transport.retry.maxRetryAfterMs) throw error;
      await transport.sleep(delay, spec.signal);
    }
  }
  throw lastError;
}
