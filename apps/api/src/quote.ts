import { createExecutionEngine, loadServerReads, type AdapterReads } from "@stacks-capital/engine";
import {
  parseQuote,
  serializePlan,
  serializeQuote,
  type Intent,
  type PlanWire,
  type QuoteWire,
  type StacksNetwork,
} from "@stacks-capital/core";
import { ApiError } from "./errors.ts";
import type { Principal } from "./auth.ts";
import type { IntentBodyValue, PlanRequestBody, QuoteRequestBody } from "./schemas.ts";

export type QuoteReads =
  | AdapterReads
  | ((input: { network: StacksNetwork; owner: string; now: Date }) => AdapterReads | Promise<AdapterReads>);

export function intentFromBody(body: QuoteRequestBody | IntentBodyValue): Intent {
  const intent: Intent = {
    action: body.action,
    marketId: body.marketId,
    amount: body.amount,
  };
  if (body.recipient !== undefined) intent.recipient = body.recipient;
  if (body.maxFee !== undefined) intent.maxFee = body.maxFee;
  if (body.minOut !== undefined) intent.minOut = body.minOut;
  if (body.collateralAmount !== undefined) intent.collateralAmount = body.collateralAmount;
  if (body.slippageBps !== undefined) intent.slippageBps = body.slippageBps;
  if (body.bufferBps !== undefined) intent.bufferBps = body.bufferBps;
  if (body.onBehalfOf !== undefined) intent.onBehalfOf = body.onBehalfOf;
  if (body.routePool !== undefined) intent.routePool = body.routePool;
  if (body.inputAsset !== undefined) intent.inputAsset = body.inputAsset;
  return intent;
}

export function toQuoteWire(quote: PlanRequestBody["quote"]): QuoteWire {
  const wire: QuoteWire = {
    id: quote.id,
    action: quote.action,
    marketId: quote.marketId,
    network: quote.network,
    input: quote.input,
    expectedOutput: quote.expectedOutput,
    fees: quote.fees.map((fee) => {
      const item: QuoteWire["fees"][number] = { kind: fee.kind, amount: fee.amount };
      if (fee.max !== undefined) item.max = fee.max;
      return item;
    }),
    snapshots: quote.snapshots,
    expiresAt: quote.expiresAt,
    executable: quote.executable,
    warnings: quote.warnings,
    registryVersion: quote.registryVersion,
    adapterVersion: quote.adapterVersion,
  };
  if (quote.minimumOutput !== undefined) wire.minimumOutput = quote.minimumOutput;
  return wire;
}

export function quoteOwner(principal: Principal, owner: string | undefined): string {
  if (principal.kind === "session") return principal.address;
  if (owner === undefined || owner === "") throw new ApiError("INVALID_REQUEST", "owner is required for API keys");
  return owner;
}

export async function resolveReads(
  reads: QuoteReads | undefined,
  input: { network: StacksNetwork; owner: string; now: Date },
): Promise<AdapterReads> {
  if (reads === undefined) {
    return loadServerReads({ network: input.network, owner: input.owner, now: input.now });
  }
  if (typeof reads === "function") return reads(input);
  return reads;
}

export async function mintQuote(input: {
  network: StacksNetwork;
  owner: string;
  now: Date;
  intent: Intent;
  reads: QuoteReads | undefined;
}): Promise<QuoteWire> {
  const reads = await resolveReads(input.reads, input);
  const engine = createExecutionEngine({
    network: input.network,
    reads,
    owner: input.owner,
    now: input.now,
  });
  return serializeQuote(engine.quote(input.intent));
}

export async function mintPlan(input: {
  network: StacksNetwork;
  owner: string;
  now: Date;
  intent: Intent;
  quote: QuoteWire;
  reads: QuoteReads | undefined;
}): Promise<PlanWire> {
  const reads = await resolveReads(input.reads, input);
  const engine = createExecutionEngine({
    network: input.network,
    reads,
    owner: input.owner,
    now: input.now,
  });
  return serializePlan(engine.plan(parseQuote(input.quote), input.intent));
}
