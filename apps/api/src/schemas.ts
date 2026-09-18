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

export const Action = z.enum([
  "deposit_sbtc",
  "withdraw_sbtc",
  "supply",
  "withdraw_supply",
  "borrow",
  "repay",
  "swap",
  "stake",
]);

const IntegerString = z.string().regex(/^[0-9]+$/);

export const IntentBody = z
  .object({
    action: Action,
    marketId: z.string().min(1).max(128),
    amount: IntegerString.max(39),
    recipient: z.string().max(128).optional(),
    maxFee: IntegerString.max(39).optional(),
    minOut: IntegerString.optional(),
    collateralAmount: IntegerString.optional(),
    slippageBps: IntegerString.max(5).optional(),
    bufferBps: IntegerString.optional(),
    onBehalfOf: z.string().max(64).optional(),
    routePool: z.string().max(128).optional(),
    inputAsset: z.string().max(64).optional(),
  })
  .openapi("Intent");

export const QuoteRequest = IntentBody.extend({
  network: Network,
  owner: z
    .string()
    .max(64)
    .optional()
    .openapi({ description: "Required for API keys. Wallet sessions quote for the signed-in address." }),
}).openapi("QuoteRequest");

export const AmountWire = z.object({
  asset: z.string().openapi({ description: "Canonical asset id from formatAssetId, never a ticker." }),
  quantity: z.string().regex(/^-?[0-9]+$/),
});

export const AssetAmount = AmountWire;

export const Fee = z.object({
  kind: z.enum(["miner", "signer", "protocol", "network"]),
  amount: AmountWire,
  max: AmountWire.optional(),
});

export const Quote = z
  .object({
    id: z.string(),
    action: Action,
    marketId: z.string(),
    network: Network,
    input: z.array(AmountWire),
    expectedOutput: z.array(AmountWire),
    fees: z.array(Fee),
    snapshots: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    executable: z.boolean(),
    warnings: z.array(z.string()),
    registryVersion: z.string(),
    adapterVersion: z.string(),
    minimumOutput: AmountWire.optional(),
  })
  .openapi("Quote");

const BitcoinPayload = z.object({
  kind: z.literal("bitcoin_deposit"),
  amountSats: IntegerString,
  stacksRecipient: z.string(),
  bitcoinNetwork: z.enum(["mainnet", "test", "regtest"]),
  reclaimLockTime: z.number().int(),
  maxSignerFeeSats: IntegerString,
  emilyNotifyPath: z.string(),
});

const StacksPayload = z.object({
  kind: z.literal("stacks_contract_call"),
  contractId: z.string(),
  functionName: z.string(),
  functionArgs: z.array(z.unknown()),
  postConditions: z.array(
    z.object({
      principal: z.string(),
      mode: z.enum(["send_lte", "send_eq", "send_gte", "receive_gte"]),
      amount: AmountWire,
    }),
  ),
  postConditionMode: z.enum(["deny", "allow"]),
  network: Network,
});

export const PlanStep = z
  .object({
    id: z.string(),
    dependsOn: z.array(z.string()),
    expectedAssetEffects: z.array(AmountWire),
    payload: z.discriminatedUnion("kind", [BitcoinPayload, StacksPayload]),
  })
  .openapi("PlanStep");

export const Plan = z
  .object({
    id: z.string(),
    quoteId: z.string(),
    network: Network,
    registryVersion: z.string(),
    adapterVersion: z.string(),
    expiresAt: z.iso.datetime(),
    reviewSummary: z.string(),
    steps: z.array(PlanStep),
  })
  .openapi("Plan");

export const PlanRequest = z
  .object({
    network: Network,
    owner: z.string().max(64).optional(),
    intent: IntentBody,
    quote: Quote,
  })
  .openapi("PlanRequest");

export const StartWorkflowRequest = z
  .object({
    network: Network,
    quoteId: z.string().max(128),
    idempotencyKey: z.string().min(8).max(128).openapi({ description: "The same key always names the same workflow." }),
    ownerAddress: z
      .string()
      .max(64)
      .optional()
      .openapi({ description: "Required for an API key, ignored for a session." }),
  })
  .openapi("StartWorkflowRequest");

export const SignatureRequest = z
  .object({
    network: Network,
    stepId: z.string().max(128),
    walletResult: z.looseObject({}).openapi({ description: "Exactly what the wallet returned, unchanged." }),
  })
  .openapi("SignatureRequest");

export const SignatureOutcome = z
  .object({
    state: z.string(),
    nextAction: z.string(),
    outcome: z.enum(["BROADCAST", "SIGNED", "UNKNOWN"]),
    txid: z.string().nullable(),
  })
  .openapi("SignatureOutcome");

export const QuoteResponse = envelope("QuoteResponse", z.object({ quote: Quote, plan: Plan }));
export const PlanResponse = envelope("PlanResponse", Plan);
export const StartedWorkflowResponse = envelope(
  "StartedWorkflowResponse",
  z.object({ workflowId: z.string(), state: z.string(), nextAction: z.string(), plan: Plan }),
);
export const SignatureResponse = envelope("SignatureResponse", SignatureOutcome);

export type QuoteRequestBody = z.infer<typeof QuoteRequest>;
export type PlanRequestBody = z.infer<typeof PlanRequest>;
export type IntentBodyValue = z.infer<typeof IntentBody>;
