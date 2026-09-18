import { createRoute } from "@hono/zod-openapi";
import {
  CapabilitiesResponse,
  ChallengeRequest,
  ChallengeResponse,
  ErrorBody,
  ListQuery,
  MarketsResponse,
  NetworkQuery,
  PlanRequest,
  PlanResponse,
  QuoteRequest,
  QuoteResponse,
  SessionResponse,
  VerifyRequest,
  WorkflowParams,
  WorkflowResponse,
} from "./schemas.ts";

const error = (description: string) => ({ description, content: { "application/json": { schema: ErrorBody } } });

const errorResponses = {
  400: error("Invalid request or network mismatch"),
  401: error("Missing or invalid credentials"),
  403: error("Credentials do not allow this request"),
  429: error("Rate limit reached. Retry after the number of seconds in retryAfter"),
  500: error("Unexpected error"),
  503: error("Temporarily unavailable"),
} as const;

// Security scheme names registered in app.ts.
const anyCaller = [{ apiKey: [] }, { walletSession: [] }, { clientId: [] }];
const browserApp = [{ clientId: [] }];
const keyOrSession = [{ apiKey: [] }, { walletSession: [] }];

const json = <T>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });

export const marketsRoute = createRoute({
  method: "get",
  path: "/v1/markets",
  security: anyCaller,
  request: { query: ListQuery },
  responses: { 200: json("Markets with their capabilities", MarketsResponse), ...errorResponses },
});

export const capabilitiesRoute = createRoute({
  method: "get",
  path: "/v1/capabilities",
  security: anyCaller,
  request: { query: ListQuery },
  responses: { 200: json("Capabilities by market and action", CapabilitiesResponse), ...errorResponses },
});

export const challengeRoute = createRoute({
  method: "post",
  path: "/v1/auth/challenge",
  security: browserApp,
  request: { body: { required: true, content: { "application/json": { schema: ChallengeRequest } } } },
  responses: { 200: json("Message for the wallet to sign", ChallengeResponse), ...errorResponses },
});

export const verifyRoute = createRoute({
  method: "post",
  path: "/v1/auth/verify",
  security: browserApp,
  request: { body: { required: true, content: { "application/json": { schema: VerifyRequest } } } },
  responses: { 200: json("Wallet session", SessionResponse), ...errorResponses },
});

export const workflowRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}",
  security: keyOrSession,
  request: { params: WorkflowParams, query: NetworkQuery },
  responses: {
    200: json("Workflow with its state transitions", WorkflowResponse),
    404: error("No workflow with this id for the caller"),
    ...errorResponses,
  },
});

export const quoteRoute = createRoute({
  method: "post",
  path: "/v1/quotes",
  security: keyOrSession,
  request: { body: { required: true, content: { "application/json": { schema: QuoteRequest } } } },
  responses: { 200: json("Unsigned quote minted from live or injected reads", QuoteResponse), ...errorResponses },
});

export const planRoute = createRoute({
  method: "post",
  path: "/v1/plans",
  security: keyOrSession,
  request: { body: { required: true, content: { "application/json": { schema: PlanRequest } } } },
  responses: { 200: json("Unsigned plan bound to a quote", PlanResponse), ...errorResponses },
});
