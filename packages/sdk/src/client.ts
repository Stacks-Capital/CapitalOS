import { REGISTRY_VERSION, capabilityFor, executableContractIds, type CapabilityRecord } from "@stacks-capital/config";
import {
  applyReorgToWorkflow,
  assertReadyToSign,
  beginConfirming as beginConfirmingWorkflow,
  beginReconciling as beginReconcilingWorkflow,
  capitalError,
  completeFromReconciliation as completeWorkflowFromReconciliation,
  createWorkflow,
  markStepConfirmed as markStepConfirmedWorkflow,
  marketsComparable,
  parsePlan,
  parseQuote,
  recordBroadcast as broadcastWorkflow,
  recordProviderOutage as outageOnWorkflow,
  recordRejection as rejectWorkflow,
  recordUnknownBroadcast as unknownBroadcastOnWorkflow,
  requireNetwork,
  resolveUnknownBroadcast as resolveUnknownOnWorkflow,
  resumeAfterReorg as resumeWorkflowAfterReorg,
  resumeHint as hintForWorkflow,
  transition,
  validatePlan,
  walletOutcome,
  type Plan,
  type PlanValidation,
  type Quote,
  type ReconciliationResult,
  type ResumeHint,
  type SigningContext,
  type StacksNetwork,
  type UnknownBroadcastResolution,
  type WalletOutcome,
  type Workflow,
} from "@stacks-capital/core";
import { classifyWalletError, networkGuard, type WalletId } from "@stacks-capital/wallets";
import type { CapitalError, ErrorCode } from "@stacks-capital/core";

export type CapitalOSOptions = {
  network: StacksNetwork;
  now?: Date;
};

export type SigningInput = Omit<SigningContext, "network" | "registryVersion" | "now"> & { now?: Date };

export type CapitalOS = {
  network: StacksNetwork;
  registryVersion: string;
  validate(plan: Plan, quote: Quote, signing?: SigningInput): PlanValidation;
  /** Throws unless the plan is safe to present to a wallet. */
  assertReadyToSign(plan: Plan, quote: Quote, signing?: SigningInput): void;
  startWorkflow(input: { id: string; idempotencyKey: string }): Workflow;
  recordQuote(workflow: Workflow, quote: Quote): Workflow;
  /**
   * Advances to AWAITING_SIGNATURE only after local plan validation passes.
   * The wallet must not open for a plan that fails this gate.
   */
  recordPlan(workflow: Workflow, plan: Plan, quote: Quote, signing?: SigningInput): Workflow;
  /** User declined in the wallet — nothing was broadcast. */
  recordRejection(workflow: Workflow, evidence?: string): Workflow;
  /** Wallet returned a txid. Never call this for an empty or missing txid. */
  recordBroadcast(workflow: Workflow, txid: string): Workflow;
  /** Wallet answer did not prove whether a write landed — read, do not rewrite. */
  recordUnknownBroadcast(workflow: Workflow, evidence: string): Workflow;
  resolveUnknownBroadcast(workflow: Workflow, resolution: UnknownBroadcastResolution): Workflow;
  beginConfirming(workflow: Workflow, evidence: string): Workflow;
  markStepConfirmed(workflow: Workflow, evidence: string): Workflow;
  beginReconciling(workflow: Workflow, evidence: string): Workflow;
  /** Completes only when canonical reconciliation matched. */
  completeFromReconciliation(workflow: Workflow, result: ReconciliationResult): Workflow;
  recordProviderOutage(workflow: Workflow, evidence: string): Workflow;
  applyReorg(workflow: Workflow, evidence: string): Workflow;
  resumeAfterReorg(workflow: Workflow, evidence: string): Workflow;
  resumeHint(workflow: Workflow): ResumeHint;
  inspectWalletResult(result: unknown): WalletOutcome;
  classifyWalletError(wallet: WalletId, error: unknown): ErrorCode;
  networkGuard(addresses: { stx?: string; btc?: string[] }): CapitalError | null;
  submit(): never;
};

function assertNetwork(workflow: Workflow, network: StacksNetwork): void {
  if (workflow.network !== network) {
    throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
  }
}

export function createCapitalOS(options: CapitalOSOptions): CapitalOS {
  const network = requireNetwork(options.network);

  function signingContext(signing: SigningInput | undefined): SigningContext {
    const context: SigningContext = {
      now: signing?.now ?? options.now ?? new Date(),
      network,
      registryVersion: REGISTRY_VERSION,
      allowedContracts: executableContractIds(network),
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
    assertReadyToSign(plan, quote, signing) {
      if (plan.network !== network || quote.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "plan or quote network does not match the SDK network");
      }
      assertReadyToSign(plan, quote, signingContext(signing));
    },
    startWorkflow(input) {
      return createWorkflow({ id: input.id, network, idempotencyKey: input.idempotencyKey });
    },
    recordQuote(workflow, quote) {
      assertNetwork(workflow, network);
      if (quote.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
      }
      return transition(workflow, "QUOTED", { reason: "quote", actor: "sdk", evidence: quote.id });
    },
    recordPlan(workflow, plan, quote, signing) {
      assertNetwork(workflow, network);
      if (plan.network !== network || quote.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
      }
      assertReadyToSign(plan, quote, signingContext(signing));
      return transition(workflow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: plan.id });
    },
    recordRejection(workflow, evidence) {
      assertNetwork(workflow, network);
      return rejectWorkflow(workflow, evidence);
    },
    recordBroadcast(workflow, txid) {
      assertNetwork(workflow, network);
      return broadcastWorkflow(workflow, txid);
    },
    recordUnknownBroadcast(workflow, evidence) {
      assertNetwork(workflow, network);
      return unknownBroadcastOnWorkflow(workflow, evidence);
    },
    resolveUnknownBroadcast(workflow, resolution) {
      assertNetwork(workflow, network);
      return resolveUnknownOnWorkflow(workflow, resolution);
    },
    beginConfirming(workflow, evidence) {
      assertNetwork(workflow, network);
      return beginConfirmingWorkflow(workflow, evidence);
    },
    markStepConfirmed(workflow, evidence) {
      assertNetwork(workflow, network);
      return markStepConfirmedWorkflow(workflow, evidence);
    },
    beginReconciling(workflow, evidence) {
      assertNetwork(workflow, network);
      return beginReconcilingWorkflow(workflow, evidence);
    },
    completeFromReconciliation(workflow, result) {
      assertNetwork(workflow, network);
      return completeWorkflowFromReconciliation(workflow, result);
    },
    recordProviderOutage(workflow, evidence) {
      assertNetwork(workflow, network);
      return outageOnWorkflow(workflow, evidence);
    },
    applyReorg(workflow, evidence) {
      assertNetwork(workflow, network);
      return applyReorgToWorkflow(workflow, evidence);
    },
    resumeAfterReorg(workflow, evidence) {
      assertNetwork(workflow, network);
      return resumeWorkflowAfterReorg(workflow, evidence);
    },
    resumeHint(workflow) {
      assertNetwork(workflow, network);
      return hintForWorkflow(workflow);
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
