import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amount, sip10 } from "./index.ts";
import { parsePlan, parseQuote, serializePlan, serializeQuote } from "./wire.ts";

const sbtc = sip10("mainnet", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", "sbtc-token");
const zft = sip10("mainnet", "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc", "zft");

describe("quote and plan wire format", () => {
  it("round-trips asset ids, not tickers", () => {
    const quote = serializeQuote({
      id: "q_1",
      action: "supply",
      marketId: "zest.sbtc.vault",
      network: "mainnet",
      input: [amount(sbtc, "100000000")],
      expectedOutput: [amount(zft, "100000000")],
      fees: [],
      snapshots: ["vault:1:1"],
      expiresAt: "2026-09-15T12:02:00.000Z",
      executable: true,
      warnings: [],
      registryVersion: "0.1.0",
      adapterVersion: "zest-earn@0.1.0",
      minimumOutput: amount(zft, "100000000"),
    });
    assert.match(quote.input[0]?.asset ?? "", /sbtc-token$/);
    assert.match(quote.expectedOutput[0]?.asset ?? "", /:zft$/);
    const restored = parseQuote(quote);
    assert.equal(restored.input[0]?.quantity, 100000000n);
    assert.equal(
      restored.expectedOutput[0]?.asset.identity.kind === "contract" &&
        restored.expectedOutput[0].asset.identity.assetName,
      "zft",
    );

    const sending = restored.input[0];
    assert.ok(sending);
    const plan = serializePlan({
      id: "p_1",
      quoteId: "q_1",
      network: "mainnet",
      registryVersion: "0.1.0",
      adapterVersion: "zest-earn@0.1.0",
      expiresAt: quote.expiresAt,
      reviewSummary: "supply",
      steps: [
        {
          id: "deposit",
          dependsOn: [],
          expectedAssetEffects: restored.expectedOutput,
          payload: {
            kind: "stacks_contract_call",
            contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
            functionName: "deposit",
            functionArgs: [],
            postConditions: [
              { principal: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR", mode: "send_lte", amount: sending },
            ],
            postConditionMode: "deny",
            network: "mainnet",
          },
        },
      ],
    });
    assert.match(
      plan.steps[0]?.payload.kind === "stacks_contract_call"
        ? (plan.steps[0].payload.postConditions[0]?.amount.asset ?? "")
        : "",
      /sbtc-token$/,
    );
    assert.equal(parsePlan(plan).steps[0]?.payload.kind, "stacks_contract_call");
  });
});
