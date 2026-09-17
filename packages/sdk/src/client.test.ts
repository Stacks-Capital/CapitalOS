import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSubmitWrite } from "@stacks-capital/core";
import { MAINNET_OWNER, MAINNET_READS, TESTNET_OWNER, TESTNET_READS, FIXTURE_NOW } from "@stacks-capital/fixtures";
import { createCapitalOS, executable, requireNetwork } from "./index.ts";

describe("public SDK", () => {
  it("requires an explicit network and does not broadcast", () => {
    assert.throws(() => requireNetwork(undefined), /no default network/);
    const os = createCapitalOS({ network: "mainnet", reads: MAINNET_READS, owner: MAINNET_OWNER, now: new Date(FIXTURE_NOW) });
    assert.throws(() => os.submit(), (error: unknown) => {
      return typeof error === "object" && error !== null && "code" in error && error.code === "UNSUPPORTED_ACTION";
    });
  });

  it("quotes, plans and validates Zest earn without importing adapters", () => {
    const os = createCapitalOS({ network: "mainnet", reads: MAINNET_READS, owner: MAINNET_OWNER, now: new Date(FIXTURE_NOW) });
    const intent = { action: "supply" as const, marketId: "zest.sbtc.vault", amount: "99999000" };
    const { quote, plan } = os.quoteAndPlan(intent);
    const checked = os.validate(plan, quote, { sender: MAINNET_OWNER });
    assert.equal(checked.ok, true);
    assert.equal(plan.steps[0]?.payload.kind, "stacks_contract_call");
    assert.equal(os.marketsComparable({ protocol: "zest", action: "supply" }, { protocol: "granite", action: "supply" }), false);
    assert.equal(executable("supply", "mainnet", "zest"), true);
  });

  it("opens Granite borrow and a Bitflow swap as unsigned plans", () => {
    const os = createCapitalOS({ network: "mainnet", reads: MAINNET_READS, owner: MAINNET_OWNER, now: new Date(FIXTURE_NOW) });
    const borrow = os.quoteAndPlan({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "50000000000" });
    assert.equal(os.validate(borrow.plan, borrow.quote, { sender: MAINNET_OWNER }).ok, true);
    const swap = os.quoteAndPlan({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" });
    assert.equal(os.validate(swap.plan, swap.quote, { sender: MAINNET_OWNER }).ok, true);
    assert.equal(swap.plan.steps[0]?.payload.kind === "stacks_contract_call" && swap.plan.steps[0].payload.functionName === "swap-x-for-y-simple-range-multi", true);
  });

  it("stops a workflow at AWAITING_SIGNATURE and treats an empty txid as unknown", () => {
    const os = createCapitalOS({ network: "mainnet", reads: MAINNET_READS, owner: MAINNET_OWNER, now: new Date(FIXTURE_NOW) });
    const { quote, plan } = os.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });
    let flow = os.startWorkflow({ id: "wf_sdk", idempotencyKey: "sdk" });
    flow = os.recordQuote(flow, quote);
    flow = os.recordPlan(flow, plan);
    assert.equal(flow.state, "AWAITING_SIGNATURE");
    assert.equal(canSubmitWrite(flow.state), true);
    assert.equal(os.inspectWalletResult({ txid: "" }), "UNKNOWN");
  });

  it("keeps testnet sBTC deposit and staking disabled", () => {
    const os = createCapitalOS({ network: "testnet", reads: TESTNET_READS, owner: TESTNET_OWNER, now: new Date(FIXTURE_NOW) });
    const quote = os.quote({ action: "deposit_sbtc", marketId: "sbtc.deposit", amount: "10000", recipient: TESTNET_OWNER });
    assert.equal(quote.executable, false);
    assert.throws(() => os.plan(quote, { action: "deposit_sbtc", marketId: "sbtc.deposit", amount: "10000", recipient: TESTNET_OWNER }));
    assert.equal(executable("stake", "mainnet"), false);
    assert.equal(os.capabilities().some((item) => item.action === "borrow" && item.state === "disabled"), true);
  });
});
