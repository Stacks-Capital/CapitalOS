import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSubmitWrite } from "@stacks-capital/core";
import { createExecutionEngine } from "@stacks-capital/engine";
import { FIXTURE_NOW, MAINNET_OWNER, MAINNET_READS } from "@stacks-capital/fixtures";
import {
  createCapitalOS,
  executable,
  parsePlan,
  parseQuote,
  requireNetwork,
  serializePlan,
  serializeQuote,
} from "./index.ts";

describe("public SDK", () => {
  it("requires an explicit network and does not broadcast", () => {
    assert.throws(() => requireNetwork(undefined), /no default network/);
    const os = createCapitalOS({ network: "mainnet", now: new Date(FIXTURE_NOW) });
    assert.throws(
      () => os.submit(),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "UNSUPPORTED_ACTION",
    );
  });

  it("validates an engine-minted Zest plan, including after JSON round-trip", () => {
    const engine = createExecutionEngine({
      network: "mainnet",
      reads: MAINNET_READS,
      owner: MAINNET_OWNER,
      now: new Date(FIXTURE_NOW),
    });
    const os = createCapitalOS({ network: "mainnet", now: new Date(FIXTURE_NOW) });
    const intent = { action: "supply" as const, marketId: "zest.sbtc.vault", amount: "99999000" };
    const { quote, plan } = engine.quoteAndPlan(intent);
    assert.equal(os.validate(plan, quote, { sender: MAINNET_OWNER }).ok, true);
    assert.equal(
      os.validate(parsePlan(serializePlan(plan)), parseQuote(serializeQuote(quote)), { sender: MAINNET_OWNER }).ok,
      true,
    );
    assert.equal(executable("supply", "mainnet", "zest"), true);
    assert.equal(executable("stake", "mainnet"), false);
  });

  it("stops a workflow at AWAITING_SIGNATURE and treats an empty txid as unknown", () => {
    const engine = createExecutionEngine({
      network: "mainnet",
      reads: MAINNET_READS,
      owner: MAINNET_OWNER,
      now: new Date(FIXTURE_NOW),
    });
    const os = createCapitalOS({ network: "mainnet", now: new Date(FIXTURE_NOW) });
    const { quote, plan } = engine.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });
    let flow = os.startWorkflow({ id: "wf_sdk", idempotencyKey: "sdk" });
    flow = os.recordQuote(flow, quote);
    flow = os.recordPlan(flow, plan, quote, { sender: MAINNET_OWNER });
    assert.equal(flow.state, "AWAITING_SIGNATURE");
    assert.equal(canSubmitWrite(flow.state), true);
    assert.equal(os.inspectWalletResult({ txid: "" }), "UNKNOWN");

    const tampered = { ...plan, quoteId: "not-this-quote" };
    assert.throws(
      () => os.recordPlan(flow, tampered, quote, { sender: MAINNET_OWNER }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "PLAN_INVALID",
    );
    assert.doesNotThrow(() => os.assertReadyToSign(plan, quote, { sender: MAINNET_OWNER }));
  });

  it("recovers rejection, unknown broadcast, outage and completes only after reconciliation", () => {
    const engine = createExecutionEngine({
      network: "mainnet",
      reads: MAINNET_READS,
      owner: MAINNET_OWNER,
      now: new Date(FIXTURE_NOW),
    });
    const os = createCapitalOS({ network: "mainnet", now: new Date(FIXTURE_NOW) });
    const { quote, plan } = engine.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });

    let rejected = os.startWorkflow({ id: "wf_rej", idempotencyKey: "rej" });
    rejected = os.recordQuote(rejected, quote);
    rejected = os.recordPlan(rejected, plan, quote, { sender: MAINNET_OWNER });
    rejected = os.recordRejection(rejected);
    assert.equal(rejected.state, "USER_REJECTED");
    assert.equal(os.resumeHint(rejected).terminal, true);

    let flow = os.startWorkflow({ id: "wf_rec", idempotencyKey: "rec" });
    flow = os.recordQuote(flow, quote);
    flow = os.recordPlan(flow, plan, quote, { sender: MAINNET_OWNER });
    flow = os.recordUnknownBroadcast(flow, "empty txid");
    assert.equal(os.resumeHint(flow).canRetryRead, true);
    assert.equal(canSubmitWrite(flow.state), false);
    flow = os.resolveUnknownBroadcast(flow, { kind: "found", txid: "0xabc" });
    flow = os.beginConfirming(flow, "mempool");
    flow = os.recordProviderOutage(flow, "provider timeout");
    assert.equal(flow.nextAction, "RETRY_READ");
    flow = os.markStepConfirmed(flow, "0xblock");
    const mismatch = os.completeFromReconciliation(flow, { matched: false, evidence: "shares" });
    assert.equal(mismatch.state, "ACTION_REQUIRED");
    flow = os.beginReconciling(flow, "position");
    flow = os.completeFromReconciliation(flow, { matched: true, evidence: "shares" });
    assert.equal(flow.state, "COMPLETED");
    assert.equal(flow.nextAction, "COMPLETE");
  });
});

describe("K36 risk exports", () => {
  it("exposes versioned Granite health interpretation without inventing prices", async () => {
    const { RISK_CALCULATION_VERSION, interpretGraniteHealth, stressGraniteCollateral, graniteProtectiveActions } =
      await import("./index.ts");
    assert.match(RISK_CALCULATION_VERSION, /^risk@/);
    assert.equal(typeof interpretGraniteHealth, "function");
    assert.equal(typeof stressGraniteCollateral, "function");
    assert.equal(typeof graniteProtectiveActions, "function");
  });
});
