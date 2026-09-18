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
    const os = createCapitalOS({ network: "mainnet" });
    const { quote, plan } = engine.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });
    let flow = os.startWorkflow({ id: "wf_sdk", idempotencyKey: "sdk" });
    flow = os.recordQuote(flow, quote);
    flow = os.recordPlan(flow, plan);
    assert.equal(flow.state, "AWAITING_SIGNATURE");
    assert.equal(canSubmitWrite(flow.state), true);
    assert.equal(os.inspectWalletResult({ txid: "" }), "UNKNOWN");
  });
});
