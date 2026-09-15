import { capitalError, type CapitalError, type ErrorCode } from "./errors.ts";
import type { PlanId, QuoteId, StepId, WorkflowId } from "./ids.ts";
import type { StacksNetwork } from "./network.ts";

export type WorkflowState =
  | "DRAFT"
  | "QUOTED"
  | "AWAITING_SIGNATURE"
  | "BROADCAST_UNKNOWN"
  | "SUBMITTED"
  | "CONFIRMING"
  | "STEP_CONFIRMED"
  | "RECONCILING"
  | "ACTION_REQUIRED"
  | "REORGED"
  | "MANUAL_REVIEW"
  | "COMPLETED"
  | "EXPIRED"
  | "USER_REJECTED"
  | "FAILED";

export type NextAction =
  | "SIGN"
  | "REQUOTE"
  | "WAIT"
  | "RETRY_READ"
  | "RECLAIM"
  | "CONTACT_SUPPORT"
  | "COMPLETE"
  | "START_NEW";

export type Transition = {
  from: WorkflowState;
  to: WorkflowState;
  reason: string;
  actor: string;
  evidence: string;
  at: string;
};

export type Workflow = {
  id: WorkflowId;
  network: StacksNetwork;
  quoteId?: QuoteId;
  planId?: PlanId;
  stepId?: StepId;
  state: WorkflowState;
  nextAction: NextAction;
  transitions: Transition[];
  idempotencyKey: string;
};

const ALLOWED: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  DRAFT: ["QUOTED", "EXPIRED", "FAILED"],
  QUOTED: ["AWAITING_SIGNATURE", "EXPIRED", "FAILED"],
  AWAITING_SIGNATURE: ["SUBMITTED", "BROADCAST_UNKNOWN", "USER_REJECTED", "EXPIRED", "FAILED"],
  BROADCAST_UNKNOWN: ["SUBMITTED", "CONFIRMING", "USER_REJECTED", "MANUAL_REVIEW", "FAILED"],
  SUBMITTED: ["CONFIRMING", "BROADCAST_UNKNOWN", "REORGED", "FAILED"],
  CONFIRMING: ["STEP_CONFIRMED", "REORGED", "BROADCAST_UNKNOWN", "ACTION_REQUIRED", "FAILED"],
  STEP_CONFIRMED: ["RECONCILING", "AWAITING_SIGNATURE", "COMPLETED", "REORGED"],
  RECONCILING: ["COMPLETED", "STEP_CONFIRMED", "REORGED", "ACTION_REQUIRED", "FAILED"],
  ACTION_REQUIRED: ["CONFIRMING", "AWAITING_SIGNATURE", "RECONCILING", "MANUAL_REVIEW", "FAILED"],
  REORGED: ["RECONCILING", "CONFIRMING", "MANUAL_REVIEW", "FAILED"],
  MANUAL_REVIEW: ["RECONCILING", "FAILED"],
  COMPLETED: ["REORGED"],
  EXPIRED: [],
  USER_REJECTED: [],
  FAILED: [],
};

export function nextActionFor(state: WorkflowState): NextAction {
  switch (state) {
    case "DRAFT":
    case "QUOTED":
    case "AWAITING_SIGNATURE":
      return state === "QUOTED" || state === "AWAITING_SIGNATURE" ? "SIGN" : "REQUOTE";
    case "BROADCAST_UNKNOWN":
    case "SUBMITTED":
    case "CONFIRMING":
      return state === "BROADCAST_UNKNOWN" ? "RETRY_READ" : "WAIT";
    case "STEP_CONFIRMED":
    case "RECONCILING":
      return "WAIT";
    case "ACTION_REQUIRED":
      return "RECLAIM";
    case "REORGED":
    case "MANUAL_REVIEW":
      return "CONTACT_SUPPORT";
    case "COMPLETED":
      return "COMPLETE";
    case "EXPIRED":
      return "REQUOTE";
    case "USER_REJECTED":
    case "FAILED":
      return "START_NEW";
  }
}

export function canSubmitWrite(state: WorkflowState): boolean {
  return state === "AWAITING_SIGNATURE";
}

export function createWorkflow(input: {
  id: WorkflowId;
  network: StacksNetwork;
  idempotencyKey: string;
  at?: string;
}): Workflow {
  return {
    id: input.id,
    network: input.network,
    state: "DRAFT",
    nextAction: nextActionFor("DRAFT"),
    transitions: [],
    idempotencyKey: input.idempotencyKey,
  };
}

export function transition(
  workflow: Workflow,
  to: WorkflowState,
  input: { reason: string; actor: string; evidence: string; at?: string },
): Workflow {
  const allowed = ALLOWED[workflow.state];
  if (!allowed.includes(to)) {
    throw capitalError("PLAN_INVALID", `Cannot move workflow ${workflow.id} from ${workflow.state} to ${to}`);
  }
  const record: Transition = {
    from: workflow.state,
    to,
    reason: input.reason,
    actor: input.actor,
    evidence: input.evidence,
    at: input.at ?? new Date().toISOString(),
  };
  const next: Workflow = {
    ...workflow,
    state: to,
    nextAction: nextActionFor(to),
    transitions: [...workflow.transitions, record],
  };
  return next;
}

export function recordUnknownBroadcast(workflow: Workflow, evidence: string): Workflow {
  return transition(workflow, "BROADCAST_UNKNOWN", {
    reason: "Wallet or broadcast result did not include a txid",
    actor: "wallet",
    evidence,
  });
}

export function applyReorgToWorkflow(workflow: Workflow, evidence: string): Workflow {
  if (workflow.state === "EXPIRED" || workflow.state === "USER_REJECTED" || workflow.state === "FAILED") {
    return workflow;
  }
  const fromCompleted = workflow.state === "COMPLETED" ? transition(workflow, "REORGED", {
    reason: "Canonical chain evidence was rewound",
    actor: "ingestion",
    evidence,
  }) : workflow.state === "REORGED" ? workflow : transition(workflow, "REORGED", {
    reason: "Canonical chain evidence was rewound",
    actor: "ingestion",
    evidence,
  });
  return fromCompleted;
}

export function errorFromState(state: WorkflowState): CapitalError | null {
  const codes: Partial<Record<WorkflowState, ErrorCode>> = {
    BROADCAST_UNKNOWN: "BROADCAST_UNKNOWN",
    USER_REJECTED: "USER_REJECTED",
    REORGED: "REORG_DETECTED",
    EXPIRED: "QUOTE_EXPIRED",
  };
  const code = codes[state];
  return code ? capitalError(code, state) : null;
}
