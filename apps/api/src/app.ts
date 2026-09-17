import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { listCapabilities, listMarkets, type Sql } from "@stacks-capital/database";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { ApiError, errorBody } from "./errors.ts";
import { CapabilitiesResponse, ErrorBody, ListQuery, MarketsResponse, SCHEMA_VERSION } from "./schemas.ts";

export type AppDependencies = { sql: Sql; now?: () => Date };
type Env = { Variables: { requestId: string } };

export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: { title: "Capital OS API", version: SCHEMA_VERSION },
} as const;

const errorResponses = {
  400: { description: "Invalid request", content: { "application/json": { schema: ErrorBody } } },
  500: { description: "Unexpected error", content: { "application/json": { schema: ErrorBody } } },
} as const;

const marketsRoute = createRoute({
  method: "get",
  path: "/v1/markets",
  request: { query: ListQuery },
  responses: {
    200: {
      description: "Markets with their capabilities",
      content: { "application/json": { schema: MarketsResponse } },
    },
    ...errorResponses,
  },
});

const capabilitiesRoute = createRoute({
  method: "get",
  path: "/v1/capabilities",
  request: { query: ListQuery },
  responses: {
    200: {
      description: "Capabilities by market and action",
      content: { "application/json": { schema: CapabilitiesResponse } },
    },
    ...errorResponses,
  },
});

export function createApp(deps: AppDependencies) {
  const now = deps.now ?? (() => new Date());
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

  app.use("*", async (c, next) => {
    const requestId = `req_${randomUUID()}`;
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  app.notFound((c) => c.json(errorBody(c.get("requestId"), "NOT_FOUND", "No such route"), 404));

  // Unexpected errors never expose internals to the client.
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(errorBody(c.get("requestId"), error.code, error.message, error.retryAfter), error.status);
    }
    return c.json(errorBody(c.get("requestId"), "INTERNAL", "Unexpected error"), 500);
  });

  app.openapi(marketsRoute, async (c) => {
    const { network, limit, cursor } = c.req.valid("query");
    const after = decodeCursor("markets", cursor, 1);
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

  app.doc31("/v1/openapi.json", OPENAPI_CONFIG);
  return app;
}
