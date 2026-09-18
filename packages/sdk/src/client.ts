import { REGISTRY_VERSION, capabilityFor, type CapabilityRecord } from "@stacks-capital/config";
import {
  capitalError,
  createWorkflow,
  marketsComparable,
  parsePlan,
  parseQuote,
  requireNetwork,
  transition,
  validatePlan,
  walletOutcome,
  type Plan,
  type PlanValidation,
  type Quote,
  type SigningContext,
  type StacksNetwork,
  type WalletOutcome,
  type Workflow,
} from "@stacks-capital/core";
import { classifyWalletError, networkGuard, type WalletId } from "@stacks-capital/wallets";
import type { CapitalError, ErrorCode } from "@stacks-capital/core";

export type CapitalOSOptions = {
  network: StacksNetwork;
  now?: Date;
};

export type CapitalOS = {
  network: StacksNetwork;
  registryVersion: string;
  validate(
    plan: Plan,
    quote: Quote,
    signing?: Omit<SigningContext, "network" | "registryVersion" | "now"> & { now?: Date },
  ): PlanValidation;
  startWorkflow(input: { id: string; idempotencyKey: string }): Workflow;
  recordQuote(workflow: Workflow, quote: Quote): Workflow;
  recordPlan(workflow: Workflow, plan: Plan): Workflow;
  inspectWalletResult(result: unknown): WalletOutcome;
  classifyWalletError(wallet: WalletId, error: unknown): ErrorCode;
  networkGuard(addresses: { stx?: string; btc?: string[] }): CapitalError | null;
  submit(): never;
};

export function createCapitalOS(options: CapitalOSOptions): CapitalOS {
  const network = requireNetwork(options.network);

  function signingContext(signing: Parameters<CapitalOS["validate"]>[2]): SigningContext {
    const context: SigningContext = {
      now: signing?.now ?? options.now ?? new Date(),
      network,
      registryVersion: REGISTRY_VERSION,
    };
    if (signing?.sender !== undefined) context.sender = signing.sender;
    if (signing?.bitcoinAddresses !== undefined) context.bitcoinAddresses = signing.bitcoinAddresses;
    return context;
  }

  return {
    network,
    registryVersion: REGISTRY_VERSION,
    validate(plan, quote, signing) {
      if (plan.network !== network || quote.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "plan or quote network does not match the SDK network");
      }
      return validatePlan(plan, quote, signingContext(signing));
    },
    startWorkflow(input) {
      return createWorkflow({ id: input.id, network, idempotencyKey: input.idempotencyKey });
    },
    recordQuote(workflow, quote) {
      if (workflow.network !== network || quote.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
      }
      return transition(workflow, "QUOTED", { reason: "quote", actor: "sdk", evidence: quote.id });
    },
    recordPlan(workflow, plan) {
      if (workflow.network !== network || plan.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
      }
      return transition(workflow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: plan.id });
    },
    inspectWalletResult(result) {
      return walletOutcome(result);
    },
    classifyWalletError(wallet, error) {
      return classifyWalletError(wallet, error);
    },
    networkGuard(addresses) {
      return networkGuard(network, addresses);
    },
    submit(): never {
      throw capitalError(
        "UNSUPPORTED_ACTION",
        "The SDK does not broadcast. The host wallet submits the unsigned plan.",
      );
    },
  };
}

export function executable(action: CapabilityRecord["action"], network: StacksNetwork, protocol?: string): boolean {
  return capabilityFor(action, requireNetwork(network), protocol)?.state === "enabled";
}

export { parsePlan, parseQuote, marketsComparable };
