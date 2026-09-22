import {
  applyReorgToWorkflow,
  beginConfirming,
  markStepConfirmed,
  transition,
  type Workflow,
  type WorkflowState,
} from "@stacks-capital/core";
import {
  advanceWorkflowFromChain,
  findCanonicalBlock,
  listWorkflowsAwaitingConfirmation,
  type NetworkName,
  type Sql,
} from "@stacks-capital/database";
import type { Hiro } from "./hiro.ts";

/**
 * Decides how far a submitted workflow may move, from chain evidence alone.
 *
 * Pilot blocker B1: a workflow reached SUBMITTED and stopped there forever, because nothing read a
 * transaction id back to the workflow that broadcast it. This module supplies the decision; the
 * worker supplies the reads and the writes.
 *
 * It stops at STEP_CONFIRMED on purpose. Completion needs canonical position reconciliation, and
 * the state machine stamps those transitions `actor: "adapter"` rather than `actor: "worker"`.
 */

/** What Hiro reports about a broadcast transaction. Pending transactions have no block yet. */
export type TransactionEvidence = {
  status: string;
  canonical: boolean;
  blockHeight: number | null;
  blockHash: string | null;
};

export type ConfirmationInput = {
  state: WorkflowState;
  /** Null when the provider has no record of the transaction at all. */
  transaction: TransactionEvidence | null;
  /** Highest block this network's ingestion has stored. Null before the first checkpoint. */
  checkpointHeight: number | null;
  /** Whether the block the transaction sits in is still the canonical one at its height. */
  blockStillCanonical: boolean;
  /** False when another plan step is still waiting to be signed. */
  isFinalStep: boolean;
};

export type ConfirmationOutcome = {
  /** The states to walk through, in order. Empty means nothing changed this tick. */
  states: WorkflowState[];
  reason: string;
};

/** Hiro statuses that mean the transaction executed and its effects are on chain. */
const SUCCESS = "success";

/** Hiro statuses that mean the transaction executed and reverted. Its effects are not on chain. */
const ABORTED = new Set(["abort_by_response", "abort_by_post_condition"]);

/** Hiro statuses that mean the transaction left the mempool without executing. */
const DROPPED = new Set([
  "dropped_replace_by_fee",
  "dropped_replace_across_fork",
  "dropped_too_expensive",
  "dropped_stale_garbage_collect",
  "dropped_problematic",
]);

const PENDING = "pending";

/**
 * A step counts as confirmed once ingestion has stored a block above the transaction's block and
 * that block is still canonical. Nothing is confirmed on the strength of the tip alone, because the
 * tip is exactly the part of the chain that reorgs.
 */
export function confirmationDecision(input: ConfirmationInput): ConfirmationOutcome {
  const none = (reason: string): ConfirmationOutcome => ({ states: [], reason });

  if (input.state !== "SUBMITTED" && input.state !== "CONFIRMING") {
    return none(`${input.state} is not waiting on chain confirmation`);
  }

  const tx = input.transaction;
  if (tx === null) {
    // Absent is not the same as dropped. Resolving that is the BROADCAST_UNKNOWN path, which the
    // API already owns, so this leaves the workflow alone rather than guessing.
    return none("provider has no record of the transaction yet");
  }

  if (tx.status === PENDING || tx.blockHeight === null) {
    return none("transaction is still in the mempool");
  }

  if (ABORTED.has(tx.status)) {
    return { states: ["FAILED"], reason: `transaction reverted on chain: ${tx.status}` };
  }

  if (DROPPED.has(tx.status)) {
    // The funds never moved, but the user's intent is unresolved, so a person decides what happens.
    return { states: ["ACTION_REQUIRED"], reason: `transaction left the mempool: ${tx.status}` };
  }

  if (tx.status !== SUCCESS) {
    return none(`unrecognised transaction status ${tx.status}`);
  }

  if (!tx.canonical || !input.blockStillCanonical) {
    return { states: ["REORGED"], reason: "the block holding the transaction is no longer canonical" };
  }

  const ahead = input.checkpointHeight !== null && input.checkpointHeight > tx.blockHeight;
  const confirming: WorkflowState[] = input.state === "SUBMITTED" ? ["CONFIRMING"] : [];

  if (!ahead) {
    return confirming.length === 0
      ? none("ingestion has not stored a block above the transaction yet")
      : { states: confirming, reason: `transaction is in canonical block ${tx.blockHeight}` };
  }

  const next: WorkflowState[] = [...confirming, "STEP_CONFIRMED"];
  if (!input.isFinalStep) next.push("AWAITING_SIGNATURE");

  return {
    states: next,
    reason: `canonical block ${tx.blockHeight} is below checkpoint ${input.checkpointHeight}`,
  };
}

/**
 * Walks a workflow through the states the decision named, using the core transitions so every move
 * is validated and recorded the same way the API's moves are.
 */
export function applyConfirmation(workflow: Workflow, outcome: ConfirmationOutcome, evidence: string): Workflow {
  let flow = workflow;
  for (const state of outcome.states) {
    switch (state) {
      case "CONFIRMING":
        flow = beginConfirming(flow, evidence);
        break;
      case "STEP_CONFIRMED":
        flow = markStepConfirmed(flow, evidence);
        break;
      case "REORGED":
        flow = applyReorgToWorkflow(flow, evidence);
        break;
      case "AWAITING_SIGNATURE":
        flow = transition(flow, "AWAITING_SIGNATURE", {
          reason: "Step confirmed; the next plan step is ready to sign",
          actor: "worker",
          evidence,
        });
        break;
      case "FAILED":
        flow = transition(flow, "FAILED", {
          reason: "Transaction reverted on chain",
          actor: "worker",
          evidence,
        });
        break;
      case "ACTION_REQUIRED":
        flow = transition(flow, "ACTION_REQUIRED", {
          reason: "Transaction left the mempool without executing",
          actor: "worker",
          evidence,
        });
        break;
      default:
        throw new Error(`No confirmation move defined for ${state}`);
    }
  }
  return flow;
}

export type AdvanceDeps = {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  at: Date;
  /** Highest block ingestion has stored this tick. */
  checkpointHeight: number | null;
  maxWorkflows?: number;
};

export type AdvanceSummary = {
  examined: number;
  advanced: number;
  unchanged: number;
  /** Reads that threw. The workflow keeps its state and is retried on the next tick. */
  unreadable: number;
};

/**
 * Moves every workflow that is waiting on chain evidence as far as that evidence allows.
 *
 * Runs after ingestion so the checkpoint it judges against is this tick's, not last tick's.
 */
export async function advanceSubmittedWorkflows(deps: AdvanceDeps): Promise<AdvanceSummary> {
  const summary: AdvanceSummary = { examined: 0, advanced: 0, unchanged: 0, unreadable: 0 };
  const pending = await listWorkflowsAwaitingConfirmation(deps.sql, {
    network: deps.network,
    limit: deps.maxWorkflows ?? 50,
  });

  for (const row of pending) {
    summary.examined += 1;

    let transaction: TransactionEvidence | null = null;
    try {
      transaction = await deps.hiro.transaction(row.txid);
    } catch {
      // A provider that cannot answer is not evidence that anything changed.
      summary.unreadable += 1;
      continue;
    }

    // Hiro calling a transaction canonical is its own view. The block is checked against stored
    // evidence as well, because ingestion is what the rest of the platform reconciles against.
    let blockStillCanonical = true;
    if (transaction.blockHash !== null && transaction.blockHeight !== null) {
      const stored = await findCanonicalBlock(deps.sql, {
        chain: "stacks",
        network: deps.network,
        height: transaction.blockHeight,
      });
      if (stored !== null) blockStillCanonical = stored.hash === transaction.blockHash;
    }

    const decision = confirmationDecision({
      state: row.state,
      transaction,
      checkpointHeight: deps.checkpointHeight,
      blockStillCanonical,
      isFinalStep: row.isFinalStep,
    });

    if (decision.states.length === 0) {
      summary.unchanged += 1;
      continue;
    }

    const before: Workflow = {
      id: row.workflowId,
      network: row.network === "mainnet" ? "mainnet" : "testnet",
      state: row.state,
      nextAction: "WAIT",
      transitions: [],
      idempotencyKey: row.workflowId,
    };
    const evidence = `tx:${row.txid} ${decision.reason}`;
    const after = applyConfirmation(before, decision, evidence);

    const written = await advanceWorkflowFromChain(deps.sql, {
      workflow: after,
      moves: after.transitions,
      expectedTransitionCount: row.transitionCount,
      at: deps.at,
    });
    if (written) summary.advanced += 1;
    else summary.unchanged += 1;
  }

  return summary;
}
