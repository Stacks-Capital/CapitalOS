import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyBlock, applyReorg, emptyIngestion } from "./ingestion.ts";
import { allowsWriteRetry, capitalError } from "./errors.ts";
import {
  applyReorgToWorkflow,
  assertWriteAllowed,
  beginConfirming,
  beginReconciling,
  canSubmitWrite,
  completeFromReconciliation,
  createWorkflow,
  markStepConfirmed,
  recordBroadcast,
  recordProviderOutage,
  recordRejection,
  recordUnknownBroadcast,
  resolveUnknownBroadcast,
  resumeAfterReorg,
  resumeHint,
  transition,
} from "./workflow.ts";

function signed(id: string) {
  let flow = createWorkflow({ id, network: "mainnet", idempotencyKey: id });
  flow = transition(flow, "QUOTED", { reason: "quote", actor: "sdk", evidence: "q" });
  flow = transition(flow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: "p" });
  return flow;
}

function throwsPlanInvalid(run: () => unknown, message: RegExp): void {
  assert.throws(run, (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "PLAN_INVALID" &&
      "message" in error &&
      typeof error.message === "string" &&
      message.test(error.message)
    );
  });
}

describe("workflow state machine", () => {
  it("walks quote, sign, confirm and reconcile without treating submit as complete", () => {
    let flow = createWorkflow({ id: "wf_1", network: "mainnet", idempotencyKey: "earn-1" });
    flow = transition(flow, "QUOTED", { reason: "quote", actor: "sdk", evidence: "q1" });
    flow = transition(flow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: "p1" });
    assert.equal(canSubmitWrite(flow.state), true);
    flow = transition(flow, "SUBMITTED", { reason: "txid", actor: "wallet", evidence: "0xabc" });
    flow = transition(flow, "CONFIRMING", { reason: "mempool", actor: "worker", evidence: "nonce" });
    flow = transition(flow, "STEP_CONFIRMED", { reason: "block", actor: "worker", evidence: "0xblock" });
    flow = transition(flow, "RECONCILING", { reason: "direct read", actor: "adapter", evidence: "position" });
    flow = transition(flow, "COMPLETED", { reason: "matched", actor: "adapter", evidence: "delta" });
    assert.equal(flow.state, "COMPLETED");
    assert.equal(flow.nextAction, "COMPLETE");
    assert.equal(flow.transitions.length, 7);
  });

  it("inspects unknown broadcasts and never allows another write from that state", () => {
    let flow = signed("wf_2");
    flow = recordUnknownBroadcast(flow, "empty txid");
    assert.equal(flow.state, "BROADCAST_UNKNOWN");
    assert.equal(flow.nextAction, "RETRY_READ");
    assert.equal(canSubmitWrite(flow.state), false);
    throwsPlanInvalid(() => assertWriteAllowed(flow), /Cannot submit a write/);
    assert.equal(allowsWriteRetry(capitalError("BROADCAST_UNKNOWN", "empty")), false);
  });

  it("moves a completed workflow to REORGED", () => {
    let flow = createWorkflow({ id: "wf_3", network: "mainnet", idempotencyKey: "r1" });
    for (const state of [
      "QUOTED",
      "AWAITING_SIGNATURE",
      "SUBMITTED",
      "CONFIRMING",
      "STEP_CONFIRMED",
      "RECONCILING",
      "COMPLETED",
    ] as const) {
      flow = transition(flow, state, { reason: state, actor: "test", evidence: state });
    }
    flow = transition(flow, "REORGED", { reason: "rewind", actor: "ingestion", evidence: "parent" });
    assert.equal(flow.state, "REORGED");
  });
});

describe("K35 recovery and reconciliation", () => {
  it("records a wallet rejection without inventing broadcast uncertainty", () => {
    const flow = recordRejection(signed("wf_reject"));
    assert.equal(flow.state, "USER_REJECTED");
    assert.equal(flow.nextAction, "START_NEW");
    assert.equal(canSubmitWrite(flow.state), false);
    assert.equal(resumeHint(flow).terminal, true);
  });

  it("records a broadcast, confirms, and completes only after matched reconciliation", () => {
    let flow = recordBroadcast(signed("wf_ok"), "0xdead");
    assert.equal(flow.state, "SUBMITTED");
    flow = beginConfirming(flow, "mempool");
    flow = markStepConfirmed(flow, "0xblock");
    throwsPlanInvalid(
      () => transition(flow, "COMPLETED", { reason: "skip", actor: "test", evidence: "no" }),
      /Cannot move workflow/,
    );
    flow = completeFromReconciliation(flow, { matched: true, evidence: "delta:ok" });
    assert.equal(flow.state, "COMPLETED");
    assert.equal(flow.nextAction, "COMPLETE");
    assert.ok(flow.transitions.some((move) => move.to === "RECONCILING"));
  });

  it("parks a reconciliation mismatch instead of completing", () => {
    let flow = signed("wf_mismatch");
    flow = recordBroadcast(flow, "0xabc");
    flow = beginConfirming(flow, "seen");
    flow = markStepConfirmed(flow, "block");
    flow = beginReconciling(flow, "position");
    flow = completeFromReconciliation(flow, { matched: false, evidence: "shares-disagree" });
    assert.equal(flow.state, "ACTION_REQUIRED");
    assert.equal(flow.nextAction, "CONTACT_SUPPORT");
    assert.equal(canSubmitWrite(flow.state), false);
  });

  it("resolves unknown broadcasts without returning to a writable sign state", () => {
    let unknown = recordUnknownBroadcast(signed("wf_unknown"), "empty");
    unknown = resolveUnknownBroadcast(unknown, { kind: "found", txid: "0xrecover" });
    assert.equal(unknown.state, "SUBMITTED");
    assert.equal(canSubmitWrite(unknown.state), false);

    let absent = recordUnknownBroadcast(signed("wf_absent"), "empty");
    absent = resolveUnknownBroadcast(absent, { kind: "absent", evidence: "not in mempool" });
    assert.equal(absent.state, "MANUAL_REVIEW");
    assert.equal(absent.nextAction, "CONTACT_SUPPORT");
    throwsPlanInvalid(
      () => transition(absent, "AWAITING_SIGNATURE", { reason: "retry", actor: "test", evidence: "no" }),
      /Cannot move workflow/,
    );
  });

  it("keeps writes closed during provider outage and after reorg resume", () => {
    let flow = recordBroadcast(signed("wf_outage"), "0x1");
    flow = beginConfirming(flow, "seen");
    flow = recordProviderOutage(flow, "hiro timeout");
    assert.equal(flow.state, "CONFIRMING");
    assert.equal(flow.nextAction, "RETRY_READ");
    assert.equal(canSubmitWrite(flow.state), false);
    assert.equal(resumeHint(flow).canRetryRead, true);

    flow = markStepConfirmed(flow, "block");
    flow = beginReconciling(flow, "position");
    flow = applyReorgToWorkflow(flow, "parent-hash");
    assert.equal(flow.state, "REORGED");
    assert.equal(flow.nextAction, "CONTACT_SUPPORT");
    flow = resumeAfterReorg(flow, "re-read");
    assert.equal(flow.state, "RECONCILING");
    assert.equal(canSubmitWrite(flow.state), false);
  });

  it("exposes resume hints for every wait and sign state", () => {
    const states = [
      signed("wf_sign"),
      recordBroadcast(signed("wf_sub"), "0x1"),
      beginConfirming(recordBroadcast(signed("wf_conf"), "0x1"), "seen"),
      recordUnknownBroadcast(signed("wf_unk"), "empty"),
    ];
    for (const flow of states) {
      const hint = resumeHint(flow);
      assert.equal(hint.resumable, true);
      assert.equal(hint.state, flow.state);
      assert.equal(hint.canSign, canSubmitWrite(flow.state));
    }
  });
});

describe("reorg-aware ingestion", () => {
  it("rewinds the checkpoint and marks orphaned events noncanonical without deleting them", () => {
    let state = emptyIngestion();
    state = applyBlock(
      state,
      {
        chain: "stacks",
        network: "mainnet",
        height: 1,
        hash: "0xa",
        parentHash: "0x0",
        canonical: true,
        observedAt: "2026-09-15T00:00:00.000Z",
        source: "hiro",
      },
      [],
    );
    state = applyBlock(
      state,
      {
        chain: "stacks",
        network: "mainnet",
        height: 2,
        hash: "0xb",
        parentHash: "0xa",
        canonical: true,
        observedAt: "2026-09-15T00:00:01.000Z",
        source: "hiro",
      },
      [
        {
          id: "evt_1",
          chain: "stacks",
          network: "mainnet",
          blockHash: "0xb",
          payload: "mint",
          canonical: true,
          observedAt: "2026-09-15T00:00:01.000Z",
          source: "hiro",
        },
      ],
    );
    state = applyReorg(state, "0xa");
    assert.equal(state.checkpoint?.hash, "0xa");
    assert.equal(state.events[0]?.canonical, false);
    assert.equal(state.events.length, 1);
  });
});
