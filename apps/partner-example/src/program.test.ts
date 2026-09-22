import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createStacksCapital } from "@stacks-capital/sdk";
import { startDemoCapitalApi, type DemoServer } from "./demo-server.ts";
import {
  DISPOSABLE_TEST_MNEMONIC,
  FALLBACK_SANDBOX_OWNER,
  getDisposableMnemonic,
  isCredentialRevoked,
  resetDisposableCredentials,
  revokeDisposableCredentials,
} from "./disposable-test-account.ts";
import { ownerFromMnemonic, signUnsignedPlan } from "./host-sign.ts";
import { runZestSupply, runZestWithdrawSupply, stakingIsDisabled } from "./program.ts";

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isMnemonic(value: string): boolean {
  return value.trim().split(/\s+/).length >= 12;
}

describe("partner example", () => {
  let demo: DemoServer;

  before(async () => {
    demo = await startDemoCapitalApi({ live: false });
  });

  after(async () => {
    await demo.close();
  });

  beforeEach(() => {
    resetDisposableCredentials();
  });

  it("completes sandbox entry (supply) through HTTP, validates and halts at AWAITING_SIGNATURE", async () => {
    const result = await runZestSupply({
      apiBase: demo.url,
      network: "mainnet",
      owner: FALLBACK_SANDBOX_OWNER,
    });
    assert.equal(result.action, "supply");
    assert.equal(result.quote.executable, true);
    assert.equal(result.quote.action, "supply");
    assert.match(result.receiptAsset, /:zft$/);
    assert.equal(result.plan.steps[0]?.payload.kind, "stacks_contract_call");
    assert.equal(result.workflowState, "AWAITING_SIGNATURE");
    assert.equal(stakingIsDisabled(), true);
  });

  it("completes sandbox exit (withdraw_supply / redeem) through HTTP, validates and halts at AWAITING_SIGNATURE", async () => {
    const result = await runZestWithdrawSupply({
      apiBase: demo.url,
      network: "mainnet",
      owner: FALLBACK_SANDBOX_OWNER,
    });
    assert.equal(result.action, "withdraw_supply");
    assert.equal(result.quote.executable, true);
    assert.equal(result.quote.action, "withdraw_supply");
    assert.match(result.outputAsset, /:sbtc-token$/);
    assert.equal(result.plan.steps[0]?.payload.kind, "stacks_contract_call");
    const payload = result.plan.steps[0]?.payload;
    if (payload?.kind === "stacks_contract_call") {
      assert.equal(payload.functionName, "redeem");
    }
    assert.equal(result.workflowState, "AWAITING_SIGNATURE");
  });

  it("derives the disposable mnemonic, signs the unsigned plan, and does not broadcast", {
    skip: isMnemonic(DISPOSABLE_TEST_MNEMONIC) ? false : "no disposable mnemonic configured",
  }, async () => {
    const os = createStacksCapital({ network: "mainnet" });
    const owner = ownerFromMnemonic(DISPOSABLE_TEST_MNEMONIC, "mainnet").address;
    assert.match(owner, /^SP/);
    assert.equal(os.networkGuard({ stx: owner }), null);

    const result = await runZestSupply({
      apiBase: demo.url,
      network: "mainnet",
      owner,
    });
    const payload = result.plan.steps[0]?.payload;
    assert.equal(payload?.kind, "stacks_contract_call");
    if (payload?.kind !== "stacks_contract_call") throw new Error("expected stacks call");
    assert.equal(payload.postConditions[0]?.principal, owner);

    const signed = await signUnsignedPlan(result.plan, DISPOSABLE_TEST_MNEMONIC, "mainnet");
    assert.equal(signed.sender, owner);
    assert.equal(signed.functionName, payload.functionName);
    assert.equal(signed.contractId, payload.contractId);
    assert.equal(os.inspectWalletResult(signed), "SIGNED");
    assert.equal("txid" in signed, false);
    assert.ok(signed.transaction.length > 100);
  });

  it("supports isolated revocable test credentials and blocks usage when revoked", () => {
    assert.equal(isCredentialRevoked(), false);
    assert.equal(getDisposableMnemonic("test test test"), "test test test");

    revokeDisposableCredentials();
    assert.equal(isCredentialRevoked(), true);
    assert.throws(() => getDisposableMnemonic("test test test"), /CREDENTIAL_REVOKED/);

    resetDisposableCredentials();
    assert.equal(isCredentialRevoked(), false);
  });

  it("rejects an invalid mnemonic before touching the API", () => {
    assert.throws(
      () => ownerFromMnemonic("not a mnemonic", "mainnet"),
      (error: unknown) => isCode(error, "PLAN_INVALID"),
    );
  });

  it("refuses to sign a plan whose sender is not the mnemonic account", async () => {
    const result = await runZestSupply({
      apiBase: demo.url,
      network: "mainnet",
      owner: FALLBACK_SANDBOX_OWNER,
    });
    await assert.rejects(
      () => signUnsignedPlan(result.plan, DISPOSABLE_TEST_MNEMONIC, "mainnet"),
      (error: unknown) => isCode(error, "PLAN_INVALID"),
    );
  });

  it("refuses to mint a plan when the API is missing", async () => {
    await assert.rejects(
      () =>
        runZestSupply({
          apiBase: "http://127.0.0.1:1",
          network: "mainnet",
          owner: FALLBACK_SANDBOX_OWNER,
        }),
      /fetch failed|ECONNREFUSED|unexpected/i,
    );
  });
});
