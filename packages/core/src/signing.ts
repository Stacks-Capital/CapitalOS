import { assertFinancialInt, type AssetAmount } from "./amounts.ts";
import { sameAsset } from "./ids.ts";
import { BITCOIN_FOR_STACKS, bitcoinAddressKind, stacksAddressNetwork } from "./network.ts";
import { quoteExpired, type Quote } from "./quote.ts";
import type { Plan, PlanStep, PlanValidation, StacksCallPayload, UnsignedPayload } from "./plan.ts";
import type { StacksNetwork } from "./network.ts";
import { capitalError } from "./errors.ts";

export type SigningContext = {
  now: Date;
  network: StacksNetwork;
  registryVersion: string;
  /** Contract principals verified by the active signed deployment registry. */
  allowedContracts?: readonly string[];
  sender?: string;
  bitcoinAddresses?: string[];
};

function amountsEqual(left: AssetAmount, right: AssetAmount): boolean {
  return sameAsset(left.asset, right.asset) && left.quantity === right.quantity;
}

function takeAmount(pool: AssetAmount[], target: AssetAmount): boolean {
  const index = pool.findIndex((item) => amountsEqual(item, target));
  if (index < 0) return false;
  pool.splice(index, 1);
  return true;
}

function includesAmount(list: readonly AssetAmount[], target: AssetAmount): boolean {
  return list.some((item) => amountsEqual(item, target));
}

function quoteReferenceAmounts(quote: Quote): AssetAmount[] {
  const refs = [...quote.input, ...quote.expectedOutput];
  if (quote.minimumOutput !== undefined) refs.push(quote.minimumOutput);
  return refs;
}

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

function stepIds(plan: Plan): Set<string> {
  return new Set(plan.steps.map((step) => step.id));
}

function dependsOnReasons(plan: Plan): string[] {
  const reasons: string[] = [];
  const ids = stepIds(plan);
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.id)) reasons.push(`duplicate plan step id ${step.id}`);
    seen.add(step.id);
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) reasons.push(`step ${step.id} cannot depend on itself`);
      if (!ids.has(dependency)) reasons.push(`step ${step.id} depends on unknown step ${dependency}`);
    }
  }
  return reasons;
}

function effectBindingReasons(plan: Plan, quote: Quote): string[] {
  const reasons: string[] = [];
  const references = quoteReferenceAmounts(quote);
  const effects: AssetAmount[] = [];
  for (const step of plan.steps) {
    for (const effect of step.expectedAssetEffects) {
      effects.push(effect);
      if (!includesAmount(references, effect)) {
        reasons.push("expected asset effect is not present on the bound quote");
      }
    }
  }

  const remainingEffects = [...effects];
  for (const output of quote.expectedOutput) {
    if (!takeAmount(remainingEffects, output)) {
      reasons.push("quote expected output is missing from plan expected effects");
    }
  }
  return reasons;
}

function postConditionBindingReasons(plan: Plan, quote: Quote, ctx: SigningContext): string[] {
  const reasons: string[] = [];
  const uncoveredInputs = [...quote.input];
  const receivePool = [...quote.expectedOutput];
  if (quote.minimumOutput !== undefined) receivePool.push(quote.minimumOutput);

  for (const step of plan.steps) {
    if (step.payload.kind === "bitcoin_deposit") {
      const depositQty = assertFinancialInt(step.payload.amountSats, "bitcoin deposit amount");
      const matched = uncoveredInputs.findIndex(
        (item) => item.asset.identity.kind === "native" && item.asset.identity.symbol === "btc" && item.quantity === depositQty,
      );
      if (matched < 0) {
        reasons.push("bitcoin deposit amount does not match quote input");
      } else {
        uncoveredInputs.splice(matched, 1);
      }
      continue;
    }

    for (const condition of step.payload.postConditions) {
      if (stacksAddressNetwork(condition.principal) !== ctx.network) {
        reasons.push("post-condition principal is on the wrong Stacks network");
      }
      if (condition.mode.startsWith("send_")) {
        if (ctx.sender !== undefined && condition.principal !== ctx.sender) {
          reasons.push("send post-condition principal must match the sender");
        }
        if (!takeAmount(uncoveredInputs, condition.amount)) {
          reasons.push("send post-condition amount is not present on the quote input");
        }
      } else if (condition.mode === "receive_gte") {
        if (!includesAmount(receivePool, condition.amount)) {
          reasons.push("receive post-condition amount is not present on the quote output");
        }
      }
    }
  }

  if (uncoveredInputs.length > 0) {
    reasons.push("quote input is not protected by a send post-condition or bitcoin deposit");
  }
  return reasons;
}

function stacksCallReasons(payload: StacksCallPayload, planNetwork: StacksNetwork, ctx: SigningContext): string[] {
  const reasons: string[] = [];
  if (payload.postConditionMode !== "deny") reasons.push("Stacks calls must use deny-mode post conditions");
  if (payload.postConditions.length === 0) reasons.push("Stacks calls must include post conditions");
  if (payload.network !== planNetwork) reasons.push("Stacks call network does not match the plan network");
  if (ctx.sender === undefined) reasons.push("sender is required before a Stacks plan can be signed");
  return reasons;
}

function bitcoinDepositReasons(step: PlanStep, planNetwork: StacksNetwork): string[] {
  const reasons: string[] = [];
  if (step.payload.kind !== "bitcoin_deposit") return reasons;
  if (step.payload.bitcoinNetwork !== BITCOIN_FOR_STACKS[planNetwork]) {
    reasons.push("bitcoin deposit network does not match the Stacks network");
  }
  if (stacksAddressNetwork(step.payload.stacksRecipient) !== planNetwork) {
    reasons.push("deposit recipient is on the wrong Stacks network");
  }
  return reasons;
}

export function validatePlan(plan: Plan, quote: Quote, ctx: SigningContext): PlanValidation {
  const reasons: string[] = [];
  if (plan.quoteId !== quote.id) reasons.push("plan is not bound to this quote");
  if (plan.network !== ctx.network || quote.network !== ctx.network) reasons.push("network mismatch");
  if (plan.network !== quote.network) reasons.push("plan and quote networks disagree");
  if (plan.registryVersion !== ctx.registryVersion || quote.registryVersion !== ctx.registryVersion) {
    reasons.push("registry version mismatch");
  }
  if (plan.adapterVersion !== quote.adapterVersion) reasons.push("adapter version mismatch");
  if (plan.expiresAt !== quote.expiresAt) reasons.push("plan expiry must match the quote");
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

  reasons.push(...dependsOnReasons(plan));
  reasons.push(...effectBindingReasons(plan, quote));
  reasons.push(...postConditionBindingReasons(plan, quote, ctx));

  for (const step of plan.steps) {
    try {
      payloadUsesNumber(step.payload);
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
    if (step.payload.kind === "stacks_contract_call") {
      if (ctx.allowedContracts === undefined) {
        reasons.push("trusted contract registry is unavailable");
      } else if (!ctx.allowedContracts.includes(step.payload.contractId)) {
        reasons.push(`contract is not approved by the active registry: ${step.payload.contractId}`);
      }
      reasons.push(...stacksCallReasons(step.payload, plan.network, ctx));
    }
    if (step.payload.kind === "bitcoin_deposit") {
      reasons.push(...bitcoinDepositReasons(step, plan.network));
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function assertValidPlan(plan: Plan, quote: Quote, ctx: SigningContext): void {
  const result = validatePlan(plan, quote, ctx);
  if (!result.ok) throw capitalError("PLAN_INVALID", result.reasons.join("; "));
}

/** Throws unless the plan is bound, fresh and locally consistent — the gate before any wallet opens. */
export function assertReadyToSign(plan: Plan, quote: Quote, ctx: SigningContext): void {
  assertValidPlan(plan, quote, ctx);
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
