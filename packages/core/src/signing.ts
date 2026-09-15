import { assertFinancialInt } from "./amounts.ts";
import { BITCOIN_FOR_STACKS, bitcoinAddressKind, stacksAddressNetwork } from "./network.ts";
import { quoteExpired, type Quote } from "./quote.ts";
import type { Plan, PlanValidation, StacksCallPayload, UnsignedPayload } from "./plan.ts";
import type { StacksNetwork } from "./network.ts";
import { capitalError } from "./errors.ts";

export type SigningContext = {
  now: Date;
  network: StacksNetwork;
  registryVersion: string;
  sender?: string;
  bitcoinAddresses?: string[];
};

function payloadUsesNumber(payload: UnsignedPayload): string | null {
  if (payload.kind === "bitcoin_deposit") {
    assertFinancialInt(payload.amountSats, "bitcoin deposit amount");
    assertFinancialInt(payload.maxSignerFeeSats, "max signer fee");
    return null;
  }
  for (const arg of payload.functionArgs) {
    if (arg.type === "uint") assertFinancialInt(arg.value, payload.functionName);
  }
  for (const condition of payload.postConditions) {
    assertFinancialInt(condition.amount.quantity.toString(10), "post condition");
  }
  return null;
}

export function validatePlan(plan: Plan, quote: Quote, ctx: SigningContext): PlanValidation {
  const reasons: string[] = [];
  if (plan.quoteId !== quote.id) reasons.push("plan is not bound to this quote");
  if (plan.network !== ctx.network || quote.network !== ctx.network) reasons.push("network mismatch");
  if (plan.registryVersion !== ctx.registryVersion || quote.registryVersion !== ctx.registryVersion) {
    reasons.push("registry version mismatch");
  }
  if (plan.adapterVersion !== quote.adapterVersion) reasons.push("adapter version mismatch");
  if (quoteExpired(quote, ctx.now) || ctx.now.toISOString() >= plan.expiresAt) reasons.push("quote expired");
  if (!quote.executable) reasons.push("quote is not executable");
  if (plan.steps.length === 0) reasons.push("plan has no steps");

  if (ctx.sender !== undefined && stacksAddressNetwork(ctx.sender) !== ctx.network) {
    reasons.push("Stacks address network mismatch");
  }
  for (const btc of ctx.bitcoinAddresses ?? []) {
    if (bitcoinAddressKind(btc) !== BITCOIN_FOR_STACKS[ctx.network]) {
      reasons.push("Bitcoin network does not match the Stacks network");
    }
  }

  for (const step of plan.steps) {
    try {
      payloadUsesNumber(step.payload);
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
    if (step.payload.kind === "stacks_contract_call") {
      const reasonsForCall = stacksCallReasons(step.payload);
      reasons.push(...reasonsForCall);
    }
    if (step.payload.kind === "bitcoin_deposit" && stacksAddressNetwork(step.payload.stacksRecipient) !== ctx.network) {
      reasons.push("deposit recipient is on the wrong Stacks network");
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function stacksCallReasons(payload: StacksCallPayload): string[] {
  const reasons: string[] = [];
  if (payload.postConditionMode !== "deny") reasons.push("Stacks calls must use deny-mode post conditions");
  if (payload.postConditions.length === 0) reasons.push("Stacks calls must include post conditions");
  return reasons;
}

export function assertValidPlan(plan: Plan, quote: Quote, ctx: SigningContext): void {
  const result = validatePlan(plan, quote, ctx);
  if (!result.ok) throw capitalError("PLAN_INVALID", result.reasons.join("; "));
}

export type WalletOutcome = "BROADCAST" | "SIGNED" | "UNKNOWN";

export function walletOutcome(result: unknown): WalletOutcome {
  if (typeof result !== "object" || result === null) return "UNKNOWN";
  if ("txid" in result && typeof result.txid === "string" && result.txid.length > 0) return "BROADCAST";
  if ("transaction" in result && typeof result.transaction === "string") return "SIGNED";
  if ("psbt" in result && typeof result.psbt === "string") return "SIGNED";
  if ("hex" in result && typeof result.hex === "string") return "SIGNED";
  return "UNKNOWN";
}
