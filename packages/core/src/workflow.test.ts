import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyBlock, applyReorg, emptyIngestion } from "./ingestion.ts";
import { canSubmitWrite, createWorkflow, recordUnknownBroadcast, transition } from "./workflow.ts";

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
  });

  it("inspects unknown broadcasts and never allows another write from that state", () => {
    let flow = createWorkflow({ id: "wf_2", network: "mainnet", idempotencyKey: "dep-1" });
    flow = transition(flow, "QUOTED", { reason: "quote", actor: "sdk", evidence: "q" });
    flow = transition(flow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: "p" });
    flow = recordUnknownBroadcast(flow, "empty txid");
    assert.equal(flow.state, "BROADCAST_UNKNOWN");
    assert.equal(flow.nextAction, "RETRY_READ");
    assert.equal(canSubmitWrite(flow.state), false);
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
