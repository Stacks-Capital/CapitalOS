import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  borrowPartialOutcome,
  continueAfterConfirmedStep,
  hasConfirmedStep,
  parkPartialCompletion,
  settleRepayAmount,
  unsignedSteps,
} from "./borrowSafety.ts";
import { createWorkflow, transition } from "./workflow.ts";

function awaitingAfterCollateral(): ReturnType<typeof createWorkflow> {
  let flow = createWorkflow({ id: "wf_loan", network: "mainnet", idempotencyKey: "loan-1" });
  flow = transition(flow, "QUOTED", { reason: "quote", actor: "sdk", evidence: "q" });
  flow = transition(flow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: "p" });
  flow = transition(flow, "SUBMITTED", { reason: "txid", actor: "wallet", evidence: "0xcol" });
  flow = transition(flow, "CONFIRMING", { reason: "included", actor: "worker", evidence: "block" });
  flow = continueAfterConfirmedStep(flow, 1);
  return flow;
}

describe("borrow UX safety", () => {
  it("signs the next unlocked plan step only", () => {
    const plan = {
      steps: [
        { id: "collateral-add", dependsOn: [] as string[] },
        { id: "borrow", dependsOn: ["collateral-add"] },
      ],
    };
    assert.deepEqual(
      unsignedSteps(plan, []).map((step) => step.id),
      ["collateral-add"],
    );
    assert.deepEqual(
      unsignedSteps(plan, ["collateral-add"]).map((step) => step.id),
      ["borrow"],
    );
    assert.deepEqual(unsignedSteps(plan, ["collateral-add", "borrow"]), []);
  });

  it("never fails a workflow that already confirmed collateral", () => {
    const partial = borrowPartialOutcome({
      confirmedStepIds: ["collateral-add"],
      rejectedOrFailedStepId: "borrow",
    });
    assert.equal(partial.failWorkflow, false);
    assert.equal(partial.preserveConfirmed, true);
    assert.equal(partial.label, "collateral_only");
    assert.equal(partial.followUp, "retry_borrow");
  });

  it("uses protocol debt as repay-all and refuses an overpay", () => {
    assert.deepEqual(settleRepayAmount("max", 50n), { amount: 50n });
    assert.deepEqual(settleRepayAmount("20", 50n), { amount: 20n });
    assert.equal("error" in settleRepayAmount("51", 50n), true);
    assert.equal("error" in settleRepayAmount("max", 0n), true);
  });

  it("parks an unsigned borrow as a follow-up, not a failed loan", () => {
    const flow = parkPartialCompletion(awaitingAfterCollateral());
    assert.equal(hasConfirmedStep(flow), true);
    assert.equal(flow.state, "ACTION_REQUIRED");
    assert.equal(flow.nextAction, "FOLLOW_UP");
    assert.notEqual(flow.state, "FAILED");
    assert.notEqual(flow.state, "USER_REJECTED");
  });

  it("rejects before any confirmation as an ordinary user rejection", () => {
    let flow = createWorkflow({ id: "wf_none", network: "mainnet", idempotencyKey: "n" });
    flow = transition(flow, "QUOTED", { reason: "q", actor: "sdk", evidence: "q" });
    flow = transition(flow, "AWAITING_SIGNATURE", { reason: "p", actor: "sdk", evidence: "p" });
    flow = parkPartialCompletion(flow);
    assert.equal(flow.state, "USER_REJECTED");
    assert.equal(flow.nextAction, "START_NEW");
  });
});
