import { jsonAmount, parseAmount } from "./amounts.ts";
import { ACTIONS, type Action, type Fee, type Quote } from "./quote.ts";
import type { ClarityValue, Plan, PlanStep, PostCondition, UnsignedPayload } from "./plan.ts";

export type AmountWire = { asset: string; quantity: string };

export type FeeWire = { kind: Fee["kind"]; amount: AmountWire; max?: AmountWire };

export type QuoteWire = {
  id: string;
  action: Action;
  marketId: string;
  network: Quote["network"];
  input: AmountWire[];
  expectedOutput: AmountWire[];
  fees: FeeWire[];
  snapshots: string[];
  expiresAt: string;
  executable: boolean;
  warnings: string[];
  registryVersion: string;
  adapterVersion: string;
  minimumOutput?: AmountWire;
};

export type PostConditionWire = {
  principal: string;
  mode: PostCondition["mode"];
  amount: AmountWire;
};

export type PayloadWire =
  | Extract<UnsignedPayload, { kind: "bitcoin_deposit" }>
  | {
      kind: "stacks_contract_call";
      contractId: string;
      functionName: string;
      functionArgs: Extract<UnsignedPayload, { kind: "stacks_contract_call" }>["functionArgs"];
      postConditions: PostConditionWire[];
      postConditionMode: "deny" | "allow";
      network: Quote["network"];
    };

export type PlanStepWire = {
  id: string;
  dependsOn: string[];
  expectedAssetEffects: AmountWire[];
  payload: PayloadWire;
};

export type PlanWire = {
  id: string;
  quoteId: string;
  network: Quote["network"];
  registryVersion: string;
  adapterVersion: string;
  expiresAt: string;
  reviewSummary: string;
  steps: PlanStepWire[];
};

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

function serializeFee(fee: Fee): FeeWire {
  const wire: FeeWire = { kind: fee.kind, amount: jsonAmount(fee.amount) };
  if (fee.max !== undefined) wire.max = jsonAmount(fee.max);
  return wire;
}

function parseFee(fee: FeeWire): Fee {
  const parsed: Fee = { kind: fee.kind, amount: parseAmount(fee.amount) };
  if (fee.max !== undefined) parsed.max = parseAmount(fee.max);
  return parsed;
}

function serializePayload(payload: UnsignedPayload): PayloadWire {
  if (payload.kind === "bitcoin_deposit") return payload;
  return {
    kind: "stacks_contract_call",
    contractId: payload.contractId,
    functionName: payload.functionName,
    functionArgs: payload.functionArgs,
    postConditions: payload.postConditions.map((item) => ({
      principal: item.principal,
      mode: item.mode,
      amount: jsonAmount(item.amount),
    })),
    postConditionMode: payload.postConditionMode,
    network: payload.network,
  };
}

function assertWireQuantity(value: unknown, label: string): void {
  if (typeof value === "number") throw new Error(`${label} cannot use a JavaScript number`);
  if (typeof value !== "string") throw new Error(`${label} must be a base-10 integer string`);
}

function assertWireClarityArgs(args: readonly ClarityValue[]): void {
  for (const arg of args) {
    if (arg.type === "uint") assertWireQuantity(arg.value, "function argument");
    if (arg.type === "some") assertWireClarityArgs([arg.value]);
    if (arg.type === "tuple") assertWireClarityArgs(Object.values(arg.value));
  }
}

function parsePayload(payload: PayloadWire): UnsignedPayload {
  if (payload.kind === "bitcoin_deposit") {
    assertWireQuantity(payload.amountSats, "bitcoin deposit amount");
    assertWireQuantity(payload.maxSignerFeeSats, "max signer fee");
    return payload;
  }
  assertWireClarityArgs(payload.functionArgs);
  return {
    kind: "stacks_contract_call",
    contractId: payload.contractId,
    functionName: payload.functionName,
    functionArgs: payload.functionArgs,
    postConditions: payload.postConditions.map((item) => ({
      principal: item.principal,
      mode: item.mode,
      amount: parseAmount(item.amount),
    })),
    postConditionMode: payload.postConditionMode,
    network: payload.network,
  };
}

export function serializeQuote(quote: Quote): QuoteWire {
  const wire: QuoteWire = {
    id: quote.id,
    action: quote.action,
    marketId: quote.marketId,
    network: quote.network,
    input: quote.input.map(jsonAmount),
    expectedOutput: quote.expectedOutput.map(jsonAmount),
    fees: quote.fees.map(serializeFee),
    snapshots: quote.snapshots,
    expiresAt: quote.expiresAt,
    executable: quote.executable,
    warnings: quote.warnings,
    registryVersion: quote.registryVersion,
    adapterVersion: quote.adapterVersion,
  };
  if (quote.minimumOutput !== undefined) wire.minimumOutput = jsonAmount(quote.minimumOutput);
  return wire;
}

export function parseQuote(wire: QuoteWire): Quote {
  if (!isAction(wire.action)) throw new Error(`Unknown action ${wire.action}`);
  const quote: Quote = {
    id: wire.id,
    action: wire.action,
    marketId: wire.marketId,
    network: wire.network,
    input: wire.input.map(parseAmount),
    expectedOutput: wire.expectedOutput.map(parseAmount),
    fees: wire.fees.map(parseFee),
    snapshots: wire.snapshots,
    expiresAt: wire.expiresAt,
    executable: wire.executable,
    warnings: wire.warnings,
    registryVersion: wire.registryVersion,
    adapterVersion: wire.adapterVersion,
  };
  if (wire.minimumOutput !== undefined) quote.minimumOutput = parseAmount(wire.minimumOutput);
  return quote;
}

export function serializePlan(plan: Plan): PlanWire {
  return {
    id: plan.id,
    quoteId: plan.quoteId,
    network: plan.network,
    registryVersion: plan.registryVersion,
    adapterVersion: plan.adapterVersion,
    expiresAt: plan.expiresAt,
    reviewSummary: plan.reviewSummary,
    steps: plan.steps.map((step) => ({
      id: step.id,
      dependsOn: step.dependsOn,
      expectedAssetEffects: step.expectedAssetEffects.map(jsonAmount),
      payload: serializePayload(step.payload),
    })),
  };
}

export function parsePlan(wire: PlanWire): Plan {
  const steps: PlanStep[] = wire.steps.map((step) => ({
    id: step.id,
    dependsOn: step.dependsOn,
    expectedAssetEffects: step.expectedAssetEffects.map(parseAmount),
    payload: parsePayload(step.payload),
  }));
  return {
    id: wire.id,
    quoteId: wire.quoteId,
    network: wire.network,
    registryVersion: wire.registryVersion,
    adapterVersion: wire.adapterVersion,
    expiresAt: wire.expiresAt,
    reviewSummary: wire.reviewSummary,
    steps,
  };
}
