import { z } from "@hono/zod-openapi";

export const SCHEMA_VERSION = "1.0";

export const Network = z.enum(["mainnet", "testnet"]).openapi({
  description: "Required on every request. There is no default network.",
});

export const ListQuery = z.object({
  network: Network,
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ description: "Page size, 1 to 100." }),
  cursor: z.string().max(512).optional().openapi({ description: "Opaque cursor from the previous page's nextCursor." }),
});

export const Context = z
  .object({
    blockHeight: z.number().int().nonnegative().optional(),
    blockHash: z.string().optional(),
    observedAt: z.iso.datetime(),
    stale: z.boolean(),
    warnings: z.array(z.string()),
  })
  .openapi("Context");

export function envelope<T extends z.ZodType>(name: string, data: T) {
  return z
    .object({
      schemaVersion: z.literal(SCHEMA_VERSION),
      requestId: z.string(),
      network: z.enum(["stacks:mainnet", "stacks:testnet"]),
      data,
      context: Context,
    })
    .openapi(name);
}

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const Capability = z
  .object({
    action: z.string(),
    state: z.enum(["enabled", "read_only", "paused", "disabled"]),
    reason: z.string(),
    contractId: z.string(),
    deploymentId: z.string().nullable(),
    adapterVersion: z.string(),
    registryVersion: z.string(),
  })
  .openapi("Capability");

export const MarketCapability = Capability.extend({ marketId: z.string() }).openapi("MarketCapability");

export const Market = z
  .object({
    id: z.string(),
    network: Network,
    protocol: z.string(),
    suppliedAssetId: z.string().nullable(),
    receiptAssetId: z.string().nullable(),
    capabilities: z.array(Capability),
  })
  .openapi("Market");

export const ErrorBody = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    requestId: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryAfter: z.number().int().nonnegative().optional(),
    }),
  })
  .openapi("Error");

export const MarketsResponse = envelope("MarketsResponse", pageOf(Market));
export const CapabilitiesResponse = envelope("CapabilitiesResponse", pageOf(MarketCapability));

export const NetworkQuery = z.object({ network: Network });

export const ChallengeRequest = z
  .object({
    network: Network,
    address: z
      .string()
      .max(64)
      .openapi({ description: "Stacks address that will sign. It must belong to the network." }),
  })
  .openapi("ChallengeRequest");

export const Challenge = z
  .object({
    nonceId: z.string(),
    message: z.string().openapi({ description: "Sign this exact text with the wallet's message signing request." }),
    expiresAt: z.iso.datetime(),
  })
  .openapi("Challenge");

export const VerifyRequest = z
  .object({
    network: Network,
    nonceId: z.string().regex(/^non_[a-f0-9]{32}$/),
    publicKey: z.string().regex(/^[0-9a-f]{66}$/),
    signature: z.string().regex(/^[0-9a-f]{130}$/),
  })
  .openapi("VerifyRequest");

export const Session = z
  .object({
    token: z.string().openapi({ description: "Bearer token for this wallet session. It is returned only once." }),
    sessionId: z.string(),
    address: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .openapi("Session");

export const WorkflowParams = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .openapi({ param: { name: "id", in: "path" } }),
});

export const Workflow = z
  .object({
    id: z.string(),
    network: Network,
    state: z.string(),
    nextAction: z.string(),
    quoteId: z.string().nullable(),
    planId: z.string().nullable(),
    ownerAddress: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    transitions: z.array(
      z.object({
        sequence: z.number().int(),
        from: z.string(),
        to: z.string(),
        reason: z.string(),
        actor: z.string(),
        evidence: z.string(),
        at: z.iso.datetime(),
      }),
    ),
  })
  .openapi("Workflow");

export const ChallengeResponse = envelope("ChallengeResponse", Challenge);
export const SessionResponse = envelope("SessionResponse", Session);
export const WorkflowResponse = envelope("WorkflowResponse", Workflow);
