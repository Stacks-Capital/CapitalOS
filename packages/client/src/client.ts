import { requireNetwork, type StacksNetwork } from "@stacks-capital/core";
import { CapitalConfigError } from "./errors.ts";
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  defaultSleep,
  type RequestSpec,
  type RetryPolicy,
  send,
  type Transport,
} from "./http.ts";
import type {
  Challenge,
  Market,
  MarketCapability,
  Page,
  QuotedPlan,
  Result,
  Session,
  SignatureOutcome,
  StartedWorkflow,
  Workflow,
} from "./types.ts";

export const CLIENT_ID_HEADER = "x-capital-client-id";

export type ClientOptions = {
  baseUrl: string;
  network: StacksNetwork;
  /** Publishable id, safe in browser code. The API only accepts it from an origin the app allows. */
  clientId?: string | undefined;
  /** Secret key. Server side only: building a client with one in a browser throws. */
  apiKey?: string | undefined;
  /** Wallet session token from verify(). */
  sessionToken?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  jitter?: () => number;
};

export type CallOptions = { signal?: AbortSignal | undefined };
export type PageOptions = CallOptions & { limit?: number | undefined; cursor?: string | undefined };

function isBrowser(): boolean {
  return typeof globalThis === "object" && "window" in globalThis && "document" in globalThis;
}

export type CapitalClient = {
  readonly network: StacksNetwork;
  readonly hasSession: boolean;
  markets(options?: PageOptions): Promise<Page<Market>>;
  allMarkets(options?: CallOptions & { maxPages?: number }): Promise<Market[]>;
  capabilities(options?: PageOptions): Promise<Page<MarketCapability>>;
  workflow(id: string, options?: CallOptions): Promise<Result<Workflow>>;
  challenge(input: { address: string }, options?: CallOptions): Promise<Result<Challenge>>;
  verify(
    input: { nonceId: string; publicKey: string; signature: string },
    options?: CallOptions,
  ): Promise<Result<Session>>;
  /** Quoting runs on the server, where the provider keys are. */
  quote(
    input: { marketId: string; action: string; amount: string; owner?: string; slippageBps?: string; maxFee?: string },
    options?: CallOptions,
  ): Promise<Result<QuotedPlan>>;
  /** The same idempotency key always names the same workflow, so a retry never starts a second one. */
  startWorkflow(
    input: { quoteId: string; idempotencyKey: string; ownerAddress?: string },
    options?: CallOptions,
  ): Promise<Result<StartedWorkflow>>;
  /** Reports exactly what the wallet answered. A result without a txid is recorded, never retried. */
  recordSignature(
    workflowId: string,
    input: { stepId: string; walletResult: unknown },
    options?: CallOptions,
  ): Promise<Result<SignatureOutcome>>;
  /** A client bound to a wallet session. The original is unchanged. */
  withSession(sessionToken: string): CapitalClient;
};

export function createClient(options: ClientOptions): CapitalClient {
  const network = requireNetwork(options.network);
  if (!/^https?:\/\//.test(options.baseUrl)) {
    throw new CapitalConfigError("baseUrl must be an absolute http or https URL");
  }
  // A secret key in browser code would ship in the bundle and be readable by anyone (SDK-01, page 03).
  if (options.apiKey !== undefined && isBrowser()) {
    throw new CapitalConfigError("An API key must never be used in a browser. Use a client id and a wallet session.");
  }
  if (options.apiKey === undefined && options.clientId === undefined && options.sessionToken === undefined) {
    throw new CapitalConfigError("Provide a clientId, an apiKey or a sessionToken");
  }

  const transport: Transport = {
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: { ...DEFAULT_RETRY, ...options.retry },
    sleep: options.sleep ?? defaultSleep,
    jitter: options.jitter ?? Math.random,
  };

  const headers = (): Record<string, string> => {
    const built: Record<string, string> = { accept: "application/json" };
    if (options.clientId !== undefined) built[CLIENT_ID_HEADER] = options.clientId;
    // A session speaks for a signed in user, so it wins over a server key when both are configured.
    const bearer = options.sessionToken ?? options.apiKey;
    if (bearer !== undefined) built.authorization = `Bearer ${bearer}`;
    return built;
  };

  const call = <T>(spec: Omit<RequestSpec, "headers">) => send<T>(transport, { ...spec, headers: headers() });

  const listPage = async <T>(path: string, page: PageOptions | undefined): Promise<Page<T>> => {
    const { data, context } = await call<{ items: T[]; nextCursor: string | null }>({
      method: "GET",
      path,
      query: { network, limit: page?.limit, cursor: page?.cursor },
      signal: page?.signal,
      retry: true,
    });
    return { items: data.items, nextCursor: data.nextCursor, context };
  };

  const client: CapitalClient = {
    network,
    hasSession: options.sessionToken !== undefined,

    markets: (page) => listPage<Market>("/v1/markets", page),
    capabilities: (page) => listPage<MarketCapability>("/v1/capabilities", page),

    async allMarkets(call_) {
      const maxPages = call_?.maxPages ?? 20;
      const items: Market[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const next = await client.markets({ limit: 100, cursor, signal: call_?.signal });
        items.push(...next.items);
        if (next.nextCursor === null) return items;
        cursor = next.nextCursor;
      }
      throw new CapitalConfigError(`Markets did not finish within ${maxPages} pages`);
    },

    workflow: (id, call_) =>
      call<Workflow>({
        method: "GET",
        path: `/v1/workflows/${encodeURIComponent(id)}`,
        query: { network },
        signal: call_?.signal,
        retry: true,
      }),

    challenge: (input, call_) =>
      call<Challenge>({
        method: "POST",
        path: "/v1/auth/challenge",
        body: { network, address: input.address },
        signal: call_?.signal,
        retry: false,
      }),

    // Never retried: a challenge can be answered once, so a second attempt would always fail.
    verify: (input, call_) =>
      call<Session>({
        method: "POST",
        path: "/v1/auth/verify",
        body: { network, ...input },
        signal: call_?.signal,
        retry: false,
      }),

    quote: (input, call_) =>
      call<QuotedPlan>({
        method: "POST",
        path: "/v1/quotes",
        body: { network, ...input },
        signal: call_?.signal,
        retry: false,
      }),

    startWorkflow: (input, call_) =>
      call<StartedWorkflow>({
        method: "POST",
        path: "/v1/workflows",
        body: { network, ...input },
        signal: call_?.signal,
        retry: false,
      }),

    recordSignature: (workflowId, input, call_) =>
      call<SignatureOutcome>({
        method: "POST",
        path: `/v1/workflows/${encodeURIComponent(workflowId)}/signature`,
        body: { network, ...input },
        signal: call_?.signal,
        retry: false,
      }),

    withSession: (sessionToken) => createClient({ ...options, sessionToken }),
  };

  return client;
}
