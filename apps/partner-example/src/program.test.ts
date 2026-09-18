import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MAINNET_OWNER } from "@stacks-capital/fixtures";
import { createCapitalOS } from "@stacks-capital/sdk";
import { DISPOSABLE_TEST_MNEMONIC } from "./disposable-test-account.ts";
import { startDemoCapitalApi, type DemoServer } from "./demo-server.ts";
import { ownerFromMnemonic, signUnsignedPlan } from "./host-sign.ts";
import { runZestSupply, stakingIsDisabled } from "./program.ts";

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("partner example", () => {
  let demo: DemoServer;

  before(async () => {
    demo = await startDemoCapitalApi({ live: false });
  });

  after(async () => {
    await demo.close();
  });

  it("quotes Zest through HTTP, then validates and stops at AWAITING_SIGNATURE with the SDK", async () => {
    const result = await runZestSupply({
      apiBase: demo.url,
      network: "mainnet",
      owner: MAINNET_OWNER,
    });
    assert.equal(result.quote.executable, true);
    assert.equal(result.quote.action, "supply");
    assert.match(result.receiptAsset, /:zft$/);
    assert.equal(result.plan.steps[0]?.payload.kind, "stacks_contract_call");
    assert.equal(result.workflowState, "AWAITING_SIGNATURE");
    assert.equal(stakingIsDisabled(), true);
  });

  it("derives the disposable mnemonic, signs the unsigned plan, and does not broadcast", async () => {
    const os = createCapitalOS({ network: "mainnet" });
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
      owner: MAINNET_OWNER,
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
          owner: MAINNET_OWNER,
        }),
      /fetch failed|ECONNREFUSED|unexpected/i,
    );
  });
});
