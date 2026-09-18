import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { stacksAddressNetwork } from "@stacks-capital/core";
import {
  createNonce,
  exchangeNonceForSession,
  findWorkflowForTenant,
  isAllowedOrigin,
  latestPositions,
  latestPrices,
  listCapabilities,
  listEarnOptions,
  listWorkflowsForTenant,
  listMarkets,
  type Sql,
} from "@stacks-capital/database";
import { cors } from "hono/cors";
import {
  authenticate,
  CLIENT_ID_HEADER,
  enforceRateLimit,
  requireClient,
  requireScope,
  signatureMatches,
} from "./auth.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { createQuote, liveReads, marketRisk, type ReadsLoader, recordSignature, startWorkflow } from "./execution.ts";
import { ApiError, errorBody } from "./errors.ts";
import { DEFAULT_RATE_LIMITS, type RateLimiter, type RateLimits } from "./rateLimit.ts";
import {
  capabilitiesRoute,
  challengeRoute,
  earnOptionsRoute,
  marketRiskRoute,
  marketsRoute,
  positionsRoute,
  pricesRoute,
  quoteRoute,
  signatureRoute,
  startWorkflowRoute,
  verifyRoute,
  workflowRoute,
  workflowsRoute,
} from "./routes.ts";
import { SCHEMA_VERSION } from "./schemas.ts";
import { serializePlan, serializeQuote } from "./serialize.ts";

export type AppDependencies = {
  sql: Sql;
  limiter: RateLimiter;
  limits?: RateLimits;
  now?: () => Date;
  /** Where quotes read market state. Defaults to live provider reads with the server's Hiro key. */
  reads?: ReadsLoader;
};
type Env = { Variables: { requestId: string } };

export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: { title: "Capital OS API", version: SCHEMA_VERSION },
} as const;

export const NONCE_TTL_SECONDS = 300;
export const SESSION_TTL_SECONDS = 3_600;

export function createApp(deps: AppDependencies) {
  const now = deps.now ?? (() => new Date());
  const limits = deps.limits ?? DEFAULT_RATE_LIMITS;
  const reads = deps.reads ?? liveReads(process.env.HIRO_API_KEY);
  const context = () => ({ observedAt: now().toISOString(), stale: false, warnings: [] });

  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
          .join("; ");
        return c.json(errorBody(c.get("requestId"), "INVALID_REQUEST", message), 400);
      }
      return undefined;
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description: "Server side API key, `key_<id>.<secret>`. Never sent from a browser.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "walletSession", {
    type: "http",
    scheme: "bearer",
    description: "Wallet session token, `ses_<id>.<secret>`, from POST /v1/auth/verify.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "clientId", {
    type: "apiKey",
    in: "header",
    name: CLIENT_ID_HEADER,
    description: "Publishable client id. Accepted only with an Origin header the app allows.",
  });

  app.use("*", async (c, next) => {
    const requestId = `req_${randomUUID()}`;
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  app.use(
    "*",
    cors({
      origin: async (origin) => (origin !== "" && (await isAllowedOrigin(deps.sql, origin)) ? origin : null),
      allowMethods: ["GET", "POST"],
      allowHeaders: ["authorization", "content-type", CLIENT_ID_HEADER],
      exposeHeaders: ["x-request-id", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after"],
      maxAge: 600,
    }),
  );

  app.notFound((c) => c.json(errorBody(c.get("requestId"), "NOT_FOUND", "No such route"), 404));

  // Unexpected errors never expose internals to the client.
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(errorBody(c.get("requestId"), error.code, error.message, error.retryAfter), error.status);
    }
    return c.json(errorBody(c.get("requestId"), "INTERNAL", "Unexpected error"), 500);
  });

  const admit = async (c: Parameters<typeof authenticate>[0]) => {
    const at = now();
    const principal = await authenticate(c, deps.sql, at);
    await enforceRateLimit(c, deps.limiter, limits, principal, at);
    return principal;
  };

  app.openapi(marketsRoute, async (c) => {
    const { network, limit, cursor } = c.req.valid("query");
    const after = decodeCursor("markets", cursor, 1);
    requireScope(await admit(c), "markets:read");
    const page = await listMarkets(deps.sql, { network, afterId: after?.[0] ?? null, limit });
    const last = page.items.at(-1);
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          items: page.items,
          nextCursor: page.hasMore && last ? encodeCursor("markets", [last.id]) : null,
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(capabilitiesRoute, async (c) => {
    const { network, limit, cursor } = c.req.valid("query");
    const after = decodeCursor("capabilities", cursor, 2);
    requireScope(await admit(c), "markets:read");
    const page = await listCapabilities(deps.sql, {
      network,
      after: after ? { marketId: after[0] ?? "", action: after[1] ?? "" } : null,
      limit,
    });
    const last = page.items.at(-1);
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          items: page.items,
          nextCursor: page.hasMore && last ? encodeCursor("capabilities", [last.marketId, last.action]) : null,
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(earnOptionsRoute, async (c) => {
    const { network } = c.req.valid("query");
    requireScope(await admit(c), "markets:read");
    const options = await listEarnOptions(deps.sql, network);
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          items: options.map((option) => ({
            marketId: option.marketId,
            protocol: option.protocol,
            suppliedAssetId: option.suppliedAssetId,
            receiptAssetId: option.receiptAssetId,
            supply: { state: option.supplyState, reason: option.supplyReason },
            withdrawal:
              option.withdrawState === null
                ? null
                : { state: option.withdrawState, reason: option.withdrawReason ?? "" },
            baseRate: option.baseRate,
            baseRateScale: option.baseRateScale,
            incentiveRate: option.incentiveRate,
            incentiveRateScale: option.incentiveRateScale,
            availableLiquidity: option.availableLiquidity,
            capacity: option.capacity,
            paused: option.paused,
            stale: option.stale,
            warnings: option.warnings,
            observedAt: option.observedAt === null ? null : option.observedAt.toISOString(),
            adapterVersion: option.adapterVersion,
          })),
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(pricesRoute, async (c) => {
    const { network } = c.req.valid("query");
    requireScope(await admit(c), "markets:read");
    const prices = await latestPrices(deps.sql, network, ["BTC/USD", "STX/USD", "sBTC/USD", "USDC/USD"]);
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          items: prices.map((price) => ({
            feedKey: price.feedKey,
            price: price.price,
            scale: price.priceScale,
            publishedAt: price.publishedAt === null ? null : price.publishedAt.toISOString(),
            observedAt: price.observedAt.toISOString(),
            source: price.source,
            stale: price.stale,
            warnings: price.warnings,
          })),
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(marketRiskRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { network, owner } = c.req.valid("query");
    const principal = await admit(c);
    if (principal.kind === "client") throw new ApiError("FORBIDDEN", "Risk needs an API key or a wallet session");
    requireScope(principal, "positions:read");
    const address = principal.kind === "session" ? principal.address : (owner ?? null);

    const known = await listMarkets(deps.sql, { network, afterId: null, limit: 100 });
    if (!known.items.some((market) => market.id === id)) throw new ApiError("NOT_FOUND", "No such market");

    const risk = await marketRisk({ sql: deps.sql, reads, now }, { network, marketId: id, owner: address });
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: risk,
        context: context(),
      },
      200,
    );
  });

  app.openapi(positionsRoute, async (c) => {
    const { network, owner } = c.req.valid("query");
    const principal = await admit(c);
    if (principal.kind === "client") throw new ApiError("FORBIDDEN", "Positions need an API key or a wallet session");
    requireScope(principal, "positions:read");
    // A session only ever reads its own address; a key must name whose positions it wants.
    const address = principal.kind === "session" ? principal.address : owner;
    if (address === undefined) throw new ApiError("INVALID_REQUEST", "owner is required for an API key");
    if (principal.kind === "session" && principal.network !== network) {
      throw new ApiError("NETWORK_MISMATCH", `Session is for ${principal.network}`);
    }

    const items = await latestPositions(deps.sql, { network, owner: address });
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          items: items.map((position) => ({
            marketId: position.marketId,
            kind: position.kind,
            protocolKey: position.protocolKey,
            assetId: position.assetId,
            quantity: position.quantity,
            stale: position.stale,
            warnings: position.warnings,
            observedAt: position.observedAt.toISOString(),
            blockHeight: position.blockHeight,
            rewardRate: position.rewardRate,
            rewardScale: position.rewardScale,
            adapterVersion: position.adapterVersion,
            calculationVersion: position.calculationVersion,
          })),
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(challengeRoute, async (c) => {
    const { network, address } = c.req.valid("json");
    const client = requireClient(await admit(c));
    if (stacksAddressNetwork(address) !== network) {
      throw new ApiError("NETWORK_MISMATCH", `Address is not a Stacks ${network} address`);
    }
    const nonce = await createNonce(deps.sql, {
      appId: client.appId,
      origin: client.origin,
      address,
      network,
      now: now(),
      ttlSeconds: NONCE_TTL_SECONDS,
    });
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: { nonceId: nonce.nonceId, message: nonce.message, expiresAt: nonce.expiresAt.toISOString() },
        context: context(),
      },
      200,
    );
  });

  app.openapi(verifyRoute, async (c) => {
    const { network, nonceId, publicKey, signature } = c.req.valid("json");
    const client = requireClient(await admit(c));
    const session = await exchangeNonceForSession(deps.sql, {
      nonceId,
      appId: client.appId,
      now: now(),
      ttlSeconds: SESSION_TTL_SECONDS,
      accept: (nonce) => nonce.network === network && signatureMatches(nonce, client.origin, { publicKey, signature }),
    });
    // One answer for every failure, so the response never reveals which check failed.
    if (session === null) throw new ApiError("UNAUTHORIZED", "Sign in failed. Request a new challenge");
    c.header("cache-control", "no-store");
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          token: session.token,
          sessionId: session.sessionId,
          address: session.address,
          expiresAt: session.expiresAt.toISOString(),
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(workflowsRoute, async (c) => {
    const { network, owner, limit, cursor } = c.req.valid("query");
    const after = decodeCursor("workflows", cursor, 2);
    const principal = await admit(c);
    if (principal.kind === "client") throw new ApiError("FORBIDDEN", "Workflows need an API key or a wallet session");
    requireScope(principal, "workflows:write");
    // A session lists only its own; a key lists its app, or one address within it.
    const ownerAddress = principal.kind === "session" ? principal.address : (owner ?? null);

    const page = await listWorkflowsForTenant(deps.sql, {
      appId: principal.appId,
      ownerAddress,
      network,
      limit,
      before: after === null ? undefined : { createdAt: new Date(after[0] ?? ""), id: after[1] ?? "" },
    });
    const last = page.items.at(-1);
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          items: page.items.map((workflow) => ({
            ...workflow,
            createdAt: workflow.createdAt.toISOString(),
            updatedAt: workflow.updatedAt.toISOString(),
          })),
          nextCursor: page.hasMore && last ? encodeCursor("workflows", [last.createdAt.toISOString(), last.id]) : null,
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(workflowRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { network } = c.req.valid("query");
    const principal = await admit(c);
    if (principal.kind === "client") throw new ApiError("FORBIDDEN", "Workflows need an API key or a wallet session");
    requireScope(principal, "workflows:write");
    if (principal.kind === "session" && principal.network !== network) {
      throw new ApiError("NETWORK_MISMATCH", `Session is for ${principal.network}`);
    }
    const workflow = await findWorkflowForTenant(deps.sql, {
      id,
      appId: principal.appId,
      ownerAddress: principal.kind === "session" ? principal.address : null,
    });
    if (workflow === null) throw new ApiError("NOT_FOUND", "No such workflow");
    if (workflow.network !== network) throw new ApiError("NETWORK_MISMATCH", `Workflow is on ${workflow.network}`);
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${network}` as const,
        data: {
          ...workflow,
          createdAt: workflow.createdAt.toISOString(),
          updatedAt: workflow.updatedAt.toISOString(),
          transitions: workflow.transitions.map((move) => ({ ...move, at: new Date(move.at).toISOString() })),
        },
        context: context(),
      },
      200,
    );
  });

  // Writing needs an account: a key with the right scope, or a signed in wallet acting for itself.
  const writer = (principal: Awaited<ReturnType<typeof admit>>, scope: "quotes:write" | "workflows:write") => {
    if (principal.kind === "client") throw new ApiError("FORBIDDEN", "This needs an API key or a wallet session");
    requireScope(principal, scope);
    return principal;
  };

  app.openapi(quoteRoute, async (c) => {
    const input = c.req.valid("json");
    const principal = writer(await admit(c), "quotes:write");
    if (principal.kind === "session" && principal.network !== input.network) {
      throw new ApiError("NETWORK_MISMATCH", `Session is for ${principal.network}`);
    }
    const owner = principal.kind === "session" ? principal.address : input.owner;
    const quoted = await createQuote(
      { sql: deps.sql, reads, now },
      {
        network: input.network,
        marketId: input.marketId,
        action: input.action,
        amount: input.amount,
        owner,
        slippageBps: input.slippageBps,
        maxFee: input.maxFee,
      },
    );
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${input.network}` as const,
        data: { quote: serializeQuote(quoted.quote), plan: serializePlan(quoted.plan) },
        context: context(),
      },
      200,
    );
  });

  app.openapi(startWorkflowRoute, async (c) => {
    const input = c.req.valid("json");
    const principal = writer(await admit(c), "workflows:write");
    if (principal.kind === "session" && principal.network !== input.network) {
      throw new ApiError("NETWORK_MISMATCH", `Session is for ${principal.network}`);
    }
    const ownerAddress = principal.kind === "session" ? principal.address : input.ownerAddress;
    if (ownerAddress === undefined) throw new ApiError("INVALID_REQUEST", "ownerAddress is required for an API key");

    const started = await startWorkflow(
      { sql: deps.sql, now },
      {
        network: input.network,
        quoteId: input.quoteId,
        idempotencyKey: input.idempotencyKey,
        appId: principal.appId,
        ownerAddress,
      },
    );
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${input.network}` as const,
        data: {
          workflowId: started.workflow.id,
          state: started.workflow.state,
          nextAction: started.workflow.nextAction,
          plan: serializePlan(started.plan),
        },
        context: context(),
      },
      200,
    );
  });

  app.openapi(signatureRoute, async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const principal = writer(await admit(c), "workflows:write");
    const outcome = await recordSignature(
      { sql: deps.sql, now },
      {
        network: input.network,
        workflowId: id,
        stepId: input.stepId,
        appId: principal.appId,
        ownerAddress: principal.kind === "session" ? principal.address : null,
        walletResult: input.walletResult,
      },
    );
    return c.json(
      {
        schemaVersion: SCHEMA_VERSION,
        requestId: c.get("requestId"),
        network: `stacks:${input.network}` as const,
        data: outcome,
        context: context(),
      },
      200,
    );
  });

  app.doc31("/v1/openapi.json", OPENAPI_CONFIG);
  return app;
}
