import { capitalError } from "./errors.ts";
import { transition, type Workflow } from "./workflow.ts";

export type BorrowPartialLabel = "collateral_only" | "nothing_confirmed" | "complete";
export type BorrowFollowUp = "retry_borrow" | "withdraw_collateral" | "none";

export type BorrowPartialOutcome = {
  failWorkflow: boolean;
  preserveConfirmed: boolean;
  label: BorrowPartialLabel;
  followUp: BorrowFollowUp;
};

export function unsignedSteps<T extends { id: string; dependsOn: readonly string[] }>(
  plan: { steps: readonly T[] },
  confirmed: readonly string[],
): T[] {
  const done = new Set(confirmed);
  return plan.steps.filter((step) => !done.has(step.id) && step.dependsOn.every((id) => done.has(id)));
}

export function hasConfirmedStep(workflow: Workflow): boolean {
  return workflow.transitions.some((move) => move.to === "STEP_CONFIRMED");
}

/**
 * Architecture §15: collateral confirmed while borrow fails is a collateral-only position.
 * The confirmed step is kept. The workflow is never labelled failed.
 */
export function borrowPartialOutcome(input: {
  confirmedStepIds: readonly string[];
  rejectedOrFailedStepId?: string;
}): BorrowPartialOutcome {
  const confirmed = new Set(input.confirmedStepIds);
  const hasCollateral = confirmed.has("collateral-add");
  const hasBorrow = confirmed.has("borrow");
  if (hasCollateral && hasBorrow) {
    return { failWorkflow: false, preserveConfirmed: true, label: "complete", followUp: "none" };
  }
  if (hasCollateral) {
    return {
      failWorkflow: false,
      preserveConfirmed: true,
      label: "collateral_only",
      followUp: input.rejectedOrFailedStepId === "borrow" ? "retry_borrow" : "withdraw_collateral",
    };
  }
  return {
    failWorkflow: input.rejectedOrFailedStepId !== undefined,
    preserveConfirmed: false,
    label: "nothing_confirmed",
    followUp: "none",
  };
}

export function settleRepayAmount(requested: string, debtBefore: bigint): { amount: bigint } | { error: string } {
  if (debtBefore <= 0n) return { error: "There is no debt to repay." };
  if (requested.trim() === "max") return { amount: debtBefore };
  if (!/^[0-9]+$/.test(requested.trim()) || requested.trim() === "") {
    return { error: "Enter an amount in base units." };
  }
  const amount = BigInt(requested.trim());
  if (amount === 0n) return { error: "Enter an amount greater than zero." };
  if (amount > debtBefore) return { error: "That is more than you owe." };
  return { amount };
}

/**
 * After a confirmed plan step, either wait for the next signature or keep the prefix.
 * CONFIRMING -> STEP_CONFIRMED, then AWAITING_SIGNATURE when more unsigned steps remain.
 */
export function continueAfterConfirmedStep(workflow: Workflow, remainingUnsigned: number): Workflow {
  const confirmed = transition(workflow, "STEP_CONFIRMED", {
    reason: "Plan step confirmed on chain",
    actor: "adapter",
    evidence: "step-confirmed",
  });
  if (remainingUnsigned <= 0) return confirmed;
  return transition(confirmed, "AWAITING_SIGNATURE", {
    reason: "Next plan step needs a signature",
    actor: "sdk",
    evidence: "unsigned-remainder",
  });
}

/**
 * User rejected or the next step cannot be signed. Confirmed collateral stays.
 * Without a confirmed prefix this is an ordinary USER_REJECTED.
 */
export function parkPartialCompletion(workflow: Workflow): Workflow {
  if (workflow.state !== "AWAITING_SIGNATURE") {
    throw capitalError("PLAN_INVALID", "partial completion can only park an unsigned remainder");
  }
  if (!hasConfirmedStep(workflow)) {
    return transition(workflow, "USER_REJECTED", {
      reason: "User rejected before any step confirmed",
      actor: "wallet",
      evidence: "rejected",
    });
  }
  return transition(workflow, "ACTION_REQUIRED", {
    reason: "Confirmed collateral is kept; unsigned borrow was not submitted",
    actor: "wallet",
    evidence: "partial:collateral-only",
  });
}
