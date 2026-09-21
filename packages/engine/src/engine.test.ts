import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executableContractIds } from "@stacks-capital/config";
import { parsePlan, parseQuote, serializePlan, serializeQuote, validatePlan } from "@stacks-capital/core";
import { FIXTURE_NOW, MAINNET_OWNER, MAINNET_READS, TESTNET_OWNER, TESTNET_READS } from "@stacks-capital/fixtures";
import { createExecutionEngine, executable } from "./engine.ts";

describe("execution engine", () => {
  it("quotes Zest, Granite and Bitflow from injected reads and round-trips the wire format", () => {
    const engine = createExecutionEngine({
      network: "mainnet",
      reads: MAINNET_READS,
      owner: MAINNET_OWNER,
      now: new Date(FIXTURE_NOW),
    });
    const supply = engine.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "99999000" });
    assert.equal(supply.quote.executable, true);
    assert.equal(
      supply.quote.expectedOutput[0]?.asset.identity.kind === "contract" &&
        supply.quote.expectedOutput[0].asset.identity.assetName,
      "zft",
    );
    const restored = parseQuote(serializeQuote(supply.quote));
    assert.equal(
      validatePlan(parsePlan(serializePlan(supply.plan)), restored, {
        now: new Date(FIXTURE_NOW),
        network: "mainnet",
        registryVersion: engine.registryVersion,
        allowedContracts: executableContractIds("mainnet"),
        sender: MAINNET_OWNER,
      }).ok,
      true,
    );

    const borrow = engine.quoteAndPlan({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "50000000000" });
    assert.equal(
      borrow.quote.expectedOutput[0]?.asset.identity.kind === "contract" &&
        borrow.quote.expectedOutput[0].asset.identity.assetName,
      "usdcx-token",
    );
    assert.equal(engine.validate(borrow.plan, borrow.quote, { sender: MAINNET_OWNER }).ok, true);

    const swap = engine.quoteAndPlan({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" });
    assert.equal(
      swap.plan.steps[0]?.payload.kind === "stacks_contract_call" && swap.plan.steps[0].payload.functionName,
      "swap-x-for-y-simple-range-multi",
    );
  });

  it("keeps testnet deposit and staking disabled", () => {
    const engine = createExecutionEngine({
      network: "testnet",
      reads: TESTNET_READS,
      owner: TESTNET_OWNER,
      now: new Date(FIXTURE_NOW),
    });
    const quote = engine.quote({
      action: "deposit_sbtc",
      marketId: "sbtc.deposit",
      amount: "10000",
      recipient: TESTNET_OWNER,
    });
    assert.equal(quote.executable, false);
    assert.throws(() =>
      engine.plan(quote, {
        action: "deposit_sbtc",
        marketId: "sbtc.deposit",
        amount: "10000",
        recipient: TESTNET_OWNER,
      }),
    );
    assert.equal(executable("stake", "mainnet"), false);
  });
});
