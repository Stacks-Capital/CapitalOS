import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Workflow } from "@stacks-capital/core";
import {
  applyConfirmation,
  confirmationDecision,
  type ConfirmationInput,
  type TransactionEvidence,
} from "./confirmations.ts";

const CONFIRMED_BLOCK = 900;
const CHECKPOINT_ABOVE = 901;

function tx(overrides: Partial<TransactionEvidence> = {}): TransactionEvidence {
  return {
    status: "success",
    canonical: true,
    blockHeight: CONFIRMED_BLOCK,
    blockHash: "0xblock",
    ...overrides,
  };
}

function input(overrides: Partial<ConfirmationInput> = {}): ConfirmationInput {
  return {
    state: "SUBMITTED",
    transaction: tx(),
    checkpointHeight: CHECKPOINT_ABOVE,
    blockStillCanonical: true,
    isFinalStep: true,
    ...overrides,
  };
}

function workflow(state: Workflow["state"]): Workflow {
  return {
    id: "wf_1",
    network: "mainnet",
    state,
    nextAction: "WAIT",
    transitions: [],
    idempotencyKey: "idem_1",
  };
}

describe("deciding how far a submitted workflow may move", () => {
  it("walks a submitted workflow to STEP_CONFIRMED once ingestion is above its block", () => {
    const decision = confirmationDecision(input());
    assert.deepEqual(decision.states, ["CONFIRMING", "STEP_CONFIRMED"]);
  });

  it("only marks CONFIRMING while ingestion is still at or below the transaction's block", () => {
    const atBlock = confirmationDecision(input({ checkpointHeight: CONFIRMED_BLOCK }));
    assert.deepEqual(atBlock.states, ["CONFIRMING"]);

    const behind = confirmationDecision(input({ checkpointHeight: CONFIRMED_BLOCK - 10 }));
    assert.deepEqual(behind.states, ["CONFIRMING"]);
  });

  it("does nothing on a second tick when the workflow is already confirming and nothing moved", () => {
    const decision = confirmationDecision(input({ state: "CONFIRMING", checkpointHeight: CONFIRMED_BLOCK }));
    assert.deepEqual(decision.states, []);
  });

  it("confirms a workflow that was already confirming without repeating CONFIRMING", () => {
    const decision = confirmationDecision(input({ state: "CONFIRMING" }));
    assert.deepEqual(decision.states, ["STEP_CONFIRMED"]);
  });

  it("asks for the next signature when the plan has another step", () => {
    const decision = confirmationDecision(input({ isFinalStep: false }));
    assert.deepEqual(decision.states, ["CONFIRMING", "STEP_CONFIRMED", "AWAITING_SIGNATURE"]);
  });

  it("never confirms before the first checkpoint exists", () => {
    const decision = confirmationDecision(input({ checkpointHeight: null }));
    assert.deepEqual(decision.states, ["CONFIRMING"]);
  });

  it("leaves a mempool transaction alone", () => {
    assert.deepEqual(
      confirmationDecision(input({ transaction: tx({ status: "pending", blockHeight: null }) })).states,
      [],
    );
  });

  it("leaves a workflow alone when the provider has no record of the transaction", () => {
    const decision = confirmationDecision(input({ transaction: null }));
    assert.deepEqual(decision.states, []);
    assert.match(decision.reason, /no record/);
  });

  it("fails a workflow whose transaction reverted, rather than confirming it", () => {
    for (const status of ["abort_by_response", "abort_by_post_condition"]) {
      const decision = confirmationDecision(input({ transaction: tx({ status }) }));
      assert.deepEqual(decision.states, ["FAILED"], status);
    }
  });

  it("sends a dropped transaction to a person instead of retrying it", () => {
    const decision = confirmationDecision(input({ transaction: tx({ status: "dropped_replace_by_fee" }) }));
    assert.deepEqual(decision.states, ["ACTION_REQUIRED"]);
  });

  it("refuses to act on a status it does not recognise", () => {
    const decision = confirmationDecision(input({ transaction: tx({ status: "something_new" }) }));
    assert.deepEqual(decision.states, []);
    assert.match(decision.reason, /unrecognised/);
  });

  it("reorgs when the transaction or its block stopped being canonical", () => {
    assert.deepEqual(confirmationDecision(input({ transaction: tx({ canonical: false }) })).states, ["REORGED"]);
    assert.deepEqual(confirmationDecision(input({ blockStillCanonical: false })).states, ["REORGED"]);
  });

  it("ignores a workflow that is not waiting on chain evidence", () => {
    for (const state of ["AWAITING_SIGNATURE", "COMPLETED", "USER_REJECTED", "STEP_CONFIRMED"] as const) {
      assert.deepEqual(confirmationDecision(input({ state })).states, [], state);
    }
  });
});

describe("applying a decision to a workflow", () => {
  it("records every state it passed through, not just the last one", () => {
    const moved = applyConfirmation(workflow("SUBMITTED"), confirmationDecision(input()), "block 900");

    assert.equal(moved.state, "STEP_CONFIRMED");
    assert.deepEqual(
      moved.transitions.map((t) => `${t.from}->${t.to}`),
      ["SUBMITTED->CONFIRMING", "CONFIRMING->STEP_CONFIRMED"],
    );
  });

  it("leaves the workflow untouched when the decision names no states", () => {
    const before = workflow("SUBMITTED");
    const after = applyConfirmation(before, { states: [], reason: "nothing to do" }, "evidence");
    assert.equal(after, before);
  });

  it("stops at STEP_CONFIRMED and never reaches COMPLETED on chain evidence alone", () => {
    const moved = applyConfirmation(workflow("SUBMITTED"), confirmationDecision(input()), "block 900");
    assert.notEqual(moved.state, "COMPLETED");
    assert.equal(moved.nextAction, "WAIT");
  });

  it("carries a multi-step plan back to a signable state", () => {
    const moved = applyConfirmation(
      workflow("SUBMITTED"),
      confirmationDecision(input({ isFinalStep: false })),
      "block 900",
    );
    assert.equal(moved.state, "AWAITING_SIGNATURE");
    assert.equal(moved.nextAction, "SIGN");
  });

  it("records a revert as FAILED with the chain status as evidence", () => {
    const decision = confirmationDecision(input({ transaction: tx({ status: "abort_by_post_condition" }) }));
    const moved = applyConfirmation(workflow("SUBMITTED"), decision, decision.reason);

    assert.equal(moved.state, "FAILED");
    assert.equal(moved.nextAction, "START_NEW");
    assert.match(moved.transitions[0]?.evidence ?? "", /abort_by_post_condition/);
  });
});
