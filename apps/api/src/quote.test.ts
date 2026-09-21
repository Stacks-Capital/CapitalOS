import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAINNET_OWNER, MAINNET_READS, FIXTURE_NOW } from "@stacks-capital/fixtures";
import { parseQuote, validatePlan, parsePlan } from "@stacks-capital/core";
import { intentFromBody, mintPlan, mintQuote } from "./quote.ts";

describe("quote service", () => {
  it("mints a Zest supply quote and plan from injected reads", async () => {
    const now = new Date(FIXTURE_NOW);
    const intent = intentFromBody({
      action: "supply",
      marketId: "zest.sbtc.vault",
      amount: "100000000",
    });
    const quote = await mintQuote({
      network: "mainnet",
      owner: MAINNET_OWNER,
      now,
      intent,
      reads: MAINNET_READS,
    });
    assert.equal(quote.executable, true);
    assert.match(quote.expectedOutput[0]?.asset ?? "", /:zft$/);
    const plan = await mintPlan({
      network: "mainnet",
      owner: MAINNET_OWNER,
      now,
      intent,
      quote,
      reads: MAINNET_READS,
    });
    assert.equal(
      validatePlan(parsePlan(plan), parseQuote(quote), {
        now,
        network: "mainnet",
        registryVersion: quote.registryVersion,
        allowedContracts: ["SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc"],
        sender: MAINNET_OWNER,
      }).ok,
      true,
    );
  });

  it("fail-closes Granite when injected DIA-equivalent oracle is stale", async () => {
    const now = new Date(FIXTURE_NOW);
    const oracle = MAINNET_READS.oracle;
    if (oracle === undefined) throw new Error("fixture oracle missing");
    await assert.rejects(
      () =>
        mintQuote({
          network: "mainnet",
          owner: MAINNET_OWNER,
          now,
          intent: { action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" },
          reads: {
            ...MAINNET_READS,
            oracle: {
              sbtc: { ...oracle.sbtc, stale: true },
              usdcx: oracle.usdcx,
            },
          },
        }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ORACLE_STALE",
    );
  });
});
