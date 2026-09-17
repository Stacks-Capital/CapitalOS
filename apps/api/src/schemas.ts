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
