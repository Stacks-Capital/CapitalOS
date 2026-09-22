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

export type StacksCapitalOptions = {
  network: StacksNetwork;
  now?: Date;
};

export type SigningInput = Omit<SigningContext, "network" | "registryVersion" | "now"> & { now?: Date };

/**
 * Local client for orchestration, plan validation, workflow progression, and wallet classification.
 * Runs in both browser and server environments without depending on Node built-ins or server internals.
 */
export type StacksCapital = {
  /** Target Stacks network. */
  network: StacksNetwork;

  /** Active protocol contract registry version. */
  registryVersion: string;

  /**
   * Validates an unsigned execution plan against a quote and signing context.
   * Evidence: Verifies post-conditions, contract principals, expiry, network, and quote parameter bindings.
   * @returns PlanValidation containing valid flag and reasons list.
   * @throws {CapitalError} With code NETWORK_MISMATCH if plan or quote network does not match SDK network.
   */
  validate(plan: Plan, quote: Quote, signing?: SigningInput): PlanValidation;

  /**
   * Hard signing boundary gate. Validates the plan and throws immediately if any check fails.
   * A wallet must never be presented with a plan that fails this assertion.
   * @throws {CapitalError} With code PLAN_INVALID, NETWORK_MISMATCH, or UNSUPPORTED_ACTION.
   */
  assertReadyToSign(plan: Plan, quote: Quote, signing?: SigningInput): void;

  /**
   * Initializes a new execution workflow in CREATED state bound by an idempotency key.
   * @throws {CapitalError} If input is invalid.
   */
  startWorkflow(input: { id: string; idempotencyKey: string }): Workflow;

  /**
   * Records quote binding evidence on the workflow and transitions to QUOTED state.
   * @throws {CapitalError} With code NETWORK_MISMATCH if quote network does not match SDK network.
   */
  recordQuote(workflow: Workflow, quote: Quote): Workflow;

  /**
   * Validates local plan against registered contracts and advances workflow to AWAITING_SIGNATURE.
   * Evidence: Checks allow/deny post-condition modes, expiry, and parameter bindings.
   * @throws {CapitalError} If validation fails or network mismatch is detected.
   */
  recordPlan(workflow: Workflow, plan: Plan, quote: Quote, signing?: SigningInput): Workflow;

  /**
   * Records that the user explicitly declined or cancelled the transaction in the wallet.
   * Transitions to REJECTED. Nothing was broadcast to the network.
   */
  recordRejection(workflow: Workflow, evidence?: string): Workflow;

  /**
   * Records a confirmed wallet broadcast returning a valid transaction ID.
   * Transitions to SUBMITTED. Never call with an empty or missing txid.
   * @throws {CapitalError} If txid is missing or workflow state forbids broadcast.
   */
  recordBroadcast(workflow: Workflow, txid: string): Workflow;

  /**
   * Records that wallet broadcast result was indeterminate (e.g. connection dropped, unknown txid).
   * Transitions to UNKNOWN_BROADCAST and fails closed to prevent double-execution.
   */
  recordUnknownBroadcast(workflow: Workflow, evidence: string): Workflow;

  /**
   * Resolves an unknown broadcast after manual or background investigation confirms landing or omission.
   */
  resolveUnknownBroadcast(workflow: Workflow, resolution: UnknownBroadcastResolution): Workflow;

  /**
   * Transitions workflow to CONFIRMING state with block hash / height evidence.
   */
  beginConfirming(workflow: Workflow, evidence: string): Workflow;

  /**
   * Marks a specific workflow step as confirmed on-chain.
   */
  markStepConfirmed(workflow: Workflow, evidence: string): Workflow;

  /**
   * Transitions workflow to RECONCILING state once on-chain execution has finished.
   */
  beginReconciling(workflow: Workflow, evidence: string): Workflow;

  /**
   * Completes a workflow only when canonical reconciliation matches expected state changes.
   * Transitions to COMPLETED or RECONCILIATION_MISMATCH.
   */
  completeFromReconciliation(workflow: Workflow, result: ReconciliationResult): Workflow;

  /**
   * Records an upstream provider outage and suspends workflow execution.
   */
  recordProviderOutage(workflow: Workflow, evidence: string): Workflow;

  /**
   * Records a detected chain reorg affecting workflow transactions without deleting audit records.
   */
  applyReorg(workflow: Workflow, evidence: string): Workflow;

  /**
   * Resumes an affected workflow safely after chain reorganization.
   */
  resumeAfterReorg(workflow: Workflow, evidence: string): Workflow;

  /**
   * Computes deterministic resume hints (action, reason, actor) for UI/partner consumption.
   */
  resumeHint(workflow: Workflow): ResumeHint;

  /**
   * Parses and classifies a raw wallet return value into a typed WalletOutcome.
   */
  inspectWalletResult(result: unknown): WalletOutcome;

  /**
   * Maps wallet-specific error structures (Leather, Xverse) to canonical Stacks Capital ErrorCodes.
   */
  classifyWalletError(wallet: WalletId, error: unknown): ErrorCode;

  /**
   * Validates address formatting and network affinity before wallet interaction.
   * Returns CapitalError on mismatch, or null if addresses are valid for the active network.
   */
  networkGuard(addresses: { stx?: string; btc?: string[] }): CapitalError | null;

  /**
   * Strictly forbidden in the SDK.
   * Failure Semantics: Always throws UNSUPPORTED_ACTION to enforce non-custodial architecture.
   * The host application or wallet must broadcast transactions.
   * @throws {CapitalError} Always throws UNSUPPORTED_ACTION.
   */
  submit(): never;
};

function assertNetwork(workflow: Workflow, network: StacksNetwork): void {
  if (workflow.network !== network) {
    throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
  }
}

export function createStacksCapital(options: StacksCapitalOptions): StacksCapital {
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
