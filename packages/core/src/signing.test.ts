import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sip10 } from "./ids.ts";
import { amount as makeAmount } from "./amounts.ts";
import { validatePlan, type SigningContext } from "./signing.ts";
import type { Plan } from "./plan.ts";
import type { Quote } from "./quote.ts";

const sbtc = sip10("mainnet", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", "sbtc-token");
const now = new Date("2026-09-15T12:00:00.000Z");

function quote(): Quote {
  return {
    id: "q1",
    action: "supply",
    marketId: "zest.sbtc.vault",
    network: "mainnet",
    input: [makeAmount(sbtc, "1000")],
    expectedOutput: [makeAmount(sbtc, "1000")],
    fees: [],
    snapshots: [],
    expiresAt: "2026-09-15T12:10:00.000Z",
    executable: true,
    warnings: [],
    registryVersion: "0.1.0",
    adapterVersion: "zest-earn@0.1.0",
    minimumOutput: makeAmount(sbtc, "1000"),
  };
}

function plan(): Plan {
  return {
    id: "p1",
    quoteId: "q1",
    network: "mainnet",
    registryVersion: "0.1.0",
    adapterVersion: "zest-earn@0.1.0",
    expiresAt: "2026-09-15T12:10:00.000Z",
    reviewSummary: "supply",
    steps: [
      {
        id: "deposit",
        dependsOn: [],
        expectedAssetEffects: [makeAmount(sbtc, "1000")],
        payload: {
          kind: "stacks_contract_call",
          contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
          functionName: "deposit",
          functionArgs: [{ type: "uint", value: "1000" }],
          postConditions: [
            {
              principal: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
              mode: "send_lte",
              amount: makeAmount(sbtc, "1000"),
            },
          ],
          postConditionMode: "deny",
          network: "mainnet",
        },
      },
    ],
  };
}

const ctx: SigningContext = {
  now,
  network: "mainnet",
  registryVersion: "0.1.0",
  sender: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
  bitcoinAddresses: ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
};

describe("signing boundary", () => {
  it("accepts a deny-mode plan bound to the quote", () => {
    assert.equal(validatePlan(plan(), quote(), ctx).ok, true);
  });

  it("rejects allow-mode post conditions, expiry, and the wrong Bitcoin network", () => {
    const allow = plan();
    const payload = allow.steps[0]?.payload;
    if (payload?.kind !== "stacks_contract_call") throw new Error("expected stacks call");
    payload.postConditionMode = "allow";
    assert.equal(validatePlan(allow, quote(), ctx).ok, false);

    const expired = validatePlan(plan(), quote(), { ...ctx, now: new Date("2026-09-15T13:00:00.000Z") });
    assert.equal(expired.ok, false);
    assert.match(expired.reasons.join(" "), /expired/);

    const mismatch = validatePlan(plan(), quote(), {
      ...ctx,
      bitcoinAddresses: ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"],
    });
    assert.equal(mismatch.ok, false);
  });

  it("does not treat native BTC as a Stacks signing target", () => {
    const depositPlan: Plan = {
      ...plan(),
      quoteId: "q2",
      adapterVersion: "sbtc-deposit@0.1.0",
      steps: [
        {
          id: "btc",
          dependsOn: [],
          expectedAssetEffects: [],
          payload: {
            kind: "bitcoin_deposit",
            amountSats: "10000",
            stacksRecipient: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
            bitcoinNetwork: "mainnet",
            reclaimLockTime: 144,
            maxSignerFeeSats: "0",
            emilyNotifyPath: "/deposit",
          },
        },
      ],
    };
    const depositQuote: Quote = { ...quote(), id: "q2", action: "deposit_sbtc", adapterVersion: "sbtc-deposit@0.1.0" };
    assert.equal(validatePlan(depositPlan, depositQuote, ctx).ok, true);
  });
});
