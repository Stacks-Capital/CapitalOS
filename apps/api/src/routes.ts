import { createRoute } from "@hono/zod-openapi";
import {
  CapabilitiesResponse,
  QuoteRequest,
  QuoteResponse,
  SignatureRequest,
  SignatureResponse,
  StartedWorkflowResponse,
  StartWorkflowRequest,
  ChallengeRequest,
  ChallengeResponse,
  ErrorBody,
  ListQuery,
  MarketsResponse,
  NetworkQuery,
  PositionQuery,
  PositionsResponse,
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

const body = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

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
  request: { body: body(ChallengeRequest) },
  responses: { 200: json("Message for the wallet to sign", ChallengeResponse), ...errorResponses },
});

export const verifyRoute = createRoute({
  method: "post",
  path: "/v1/auth/verify",
  security: browserApp,
  request: { body: body(VerifyRequest) },
  responses: { 200: json("Wallet session", SessionResponse), ...errorResponses },
});

export const quoteRoute = createRoute({
  method: "post",
  path: "/v1/quotes",
  security: keyOrSession,
  request: { body: body(QuoteRequest) },
  responses: { 200: json("A quote and the plan that executes it", QuoteResponse), ...errorResponses },
});

export const startWorkflowRoute = createRoute({
  method: "post",
  path: "/v1/workflows",
  security: keyOrSession,
  request: { body: body(StartWorkflowRequest) },
  responses: {
    200: json("The workflow and the plan to sign", StartedWorkflowResponse),
    404: error("No such quote"),
    ...errorResponses,
  },
});

export const signatureRoute = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/signature",
  security: keyOrSession,
  request: { params: WorkflowParams, body: body(SignatureRequest) },
  responses: {
    200: json("What the wallet answered, and where the workflow stands", SignatureResponse),
    404: error("No such workflow for the caller"),
    ...errorResponses,
  },
});

export const positionsRoute = createRoute({
  method: "get",
  path: "/v1/positions",
  security: keyOrSession,
  request: { query: PositionQuery },
  responses: { 200: json("Positions for one address", PositionsResponse), ...errorResponses },
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
