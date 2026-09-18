import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityFor } from "@stacks-capital/config";
import {
  applyReorgToWorkflow,
  assertValidPlan,
  canSubmitWrite,
  continueAfterConfirmedStep,
  createWorkflow,
  parkPartialCompletion,
  quoteExpired,
  recordUnknownBroadcast,
  transition,
  walletOutcome,
} from "@stacks-capital/core";
import { adapterContext, MAINNET_OWNER, MAINNET_READS, sandboxAdapters } from "./index.ts";
import type { AdapterReads } from "@stacks-capital/adapters";

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

function withReads(patch: (base: AdapterReads) => AdapterReads): AdapterReads {
  return patch(MAINNET_READS);
}

describe("K18 failure injection and recovery drill", () => {
  it("fail-closes a stale oracle, an expired quote, and a paused vault without an executable plan", () => {
    const ctx = adapterContext("mainnet");
    const oracle = MAINNET_READS.oracle;
    assert.ok(oracle);
    const { granite: stale } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({
        ...base,
        oracle: { sbtc: { ...oracle.sbtc, stale: true }, usdcx: oracle.usdcx },
      })),
    );
    assert.throws(
      () => stale.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }),
      (error: unknown) => codeOf(error) === "ORACLE_STALE",
    );

    const vault = MAINNET_READS.debtVault;
    assert.ok(vault);
    const { granite: paused } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({
        ...base,
        debtVault: { ...vault, pausedRedeem: true },
      })),
    );
    assert.throws(
      () => paused.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }),
      (error: unknown) => codeOf(error) === "CAPABILITY_DISABLED",
    );

    const { granite } = sandboxAdapters("mainnet");
    const quote = granite.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" });
    const plan = granite.buildPlan(ctx, quote, {
      action: "borrow",
      marketId: "granite.sbtc.isolated",
      amount: "1000000",
    });
    assert.equal(quoteExpired(quote, new Date("2026-09-15T12:03:00.000Z")), true);
    assert.throws(() =>
      assertValidPlan(plan, quote, {
        now: new Date("2026-09-15T12:03:00.000Z"),
        network: "mainnet",
        registryVersion: ctx.registryVersion,
        sender: MAINNET_OWNER,
      }),
    );
  });

  it("inspects an unknown broadcast and a reorg instead of retrying the write", () => {
    let flow = createWorkflow({ id: "wf_abort", network: "mainnet", idempotencyKey: "abort" });
    flow = transition(flow, "QUOTED", { reason: "q", actor: "sdk", evidence: "q" });
    flow = transition(flow, "AWAITING_SIGNATURE", { reason: "p", actor: "sdk", evidence: "p" });
    assert.equal(walletOutcome({ txid: "" }), "UNKNOWN");
    flow = recordUnknownBroadcast(flow, "wallet hung");
    assert.equal(flow.nextAction, "RETRY_READ");
    assert.equal(canSubmitWrite(flow.state), false);
    let confirmed = createWorkflow({ id: "wf_reorg_drill", network: "mainnet", idempotencyKey: "reorg" });
    for (const state of [
      "QUOTED",
      "AWAITING_SIGNATURE",
      "SUBMITTED",
      "CONFIRMING",
      "STEP_CONFIRMED",
      "RECONCILING",
      "COMPLETED",
    ] as const) {
      confirmed = transition(confirmed, state, { reason: state, actor: "test", evidence: state });
    }
    confirmed = applyReorgToWorkflow(confirmed, "common-ancestor");
    assert.equal(confirmed.state, "REORGED");
    assert.equal(confirmed.nextAction, "CONTACT_SUPPORT");
  });

  it("keeps confirmed collateral when the borrow signature is refused", () => {
    const ctx = adapterContext("mainnet");
    const { granite } = sandboxAdapters("mainnet");
    const intent = {
      action: "borrow" as const,
      marketId: "granite.sbtc.isolated",
      amount: "40000000000",
      collateralAmount: "50000000",
    };
    const quote = granite.quote(ctx, intent);
    const plan = granite.buildPlan(ctx, quote, intent);
    assert.equal(plan.steps.map((step) => step.id).join(","), "collateral-add,borrow");

    let flow = createWorkflow({ id: "wf_partial", network: "mainnet", idempotencyKey: "partial" });
    flow = transition(flow, "QUOTED", { reason: "quote", actor: "sdk", evidence: quote.id });
    flow = transition(flow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: plan.id });
    flow = transition(flow, "SUBMITTED", { reason: "collateral tx", actor: "wallet", evidence: "0xcol" });
    flow = transition(flow, "CONFIRMING", { reason: "included", actor: "worker", evidence: "block" });
    flow = continueAfterConfirmedStep(flow, 1);
    assert.equal(flow.state, "AWAITING_SIGNATURE");
    flow = parkPartialCompletion(flow);
    assert.equal(flow.state, "ACTION_REQUIRED");
    assert.equal(flow.nextAction, "FOLLOW_UP");
    assert.notEqual(flow.state, "FAILED");
  });

  it("leaves staking disabled so an unverified lockup path cannot be injected", () => {
    assert.equal(capabilityFor("stake", "mainnet")?.state, "disabled");
    assert.equal(capabilityFor("deposit_sbtc", "testnet")?.state, "disabled");
  });
});
