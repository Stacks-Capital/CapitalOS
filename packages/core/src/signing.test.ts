import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bitcoinNative, sip10 } from "./ids.ts";
import { amount as makeAmount } from "./amounts.ts";
import { assertReadyToSign, validatePlan, type SigningContext } from "./signing.ts";
import type { Plan } from "./plan.ts";
import type { Quote } from "./quote.ts";

const sbtc = sip10("mainnet", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", "sbtc-token");
const btc = bitcoinNative("mainnet");
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
  allowedContracts: ["SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc"],
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

  it("rejects contract calls when the signed registry is absent or the target is unknown", () => {
    const { allowedContracts: _allowedContracts, ...withoutRegistry } = ctx;
    const unavailable = validatePlan(plan(), quote(), withoutRegistry);
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.reasons.join(" "), /registry is unavailable/);

    const unknown = plan();
    const payload = unknown.steps[0]?.payload;
    if (payload?.kind !== "stacks_contract_call") throw new Error("expected stacks call");
    payload.contractId = "SP000000000000000000002Q6VF78.unreviewed";
    const checked = validatePlan(unknown, quote(), ctx);
    assert.equal(checked.ok, false);
    assert.match(checked.reasons.join(" "), /not approved by the active registry/);
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
          expectedAssetEffects: [makeAmount(sbtc, "10000")],
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
    const depositQuote: Quote = {
      ...quote(),
      id: "q2",
      action: "deposit_sbtc",
      adapterVersion: "sbtc-deposit@0.1.0",
      input: [makeAmount(btc, "10000")],
      expectedOutput: [makeAmount(sbtc, "10000")],
      minimumOutput: makeAmount(sbtc, "10000"),
    };
    assert.equal(validatePlan(depositPlan, depositQuote, ctx).ok, true);
  });

  it("rejects tampered expiry, cross-network Stacks calls, and numeric quantities", () => {
    const staleExpiry = plan();
    staleExpiry.expiresAt = "2026-09-15T12:09:00.000Z";
    const expiry = validatePlan(staleExpiry, quote(), ctx);
    assert.equal(expiry.ok, false);
    assert.match(expiry.reasons.join(" "), /expiry must match/);

    const crossNetwork = plan();
    const payload = crossNetwork.steps[0]?.payload;
    if (payload?.kind !== "stacks_contract_call") throw new Error("expected stacks call");
    payload.network = "testnet";
    assert.equal(validatePlan(crossNetwork, quote(), ctx).ok, false);

    const numeric = plan();
    const numericPayload = numeric.steps[0]?.payload;
    if (numericPayload?.kind !== "stacks_contract_call") throw new Error("expected stacks call");
    numericPayload.functionArgs = [{ type: "uint", value: 1000 as unknown as string }];
    const numbers = validatePlan(numeric, quote(), ctx);
    assert.equal(numbers.ok, false);
    assert.match(numbers.reasons.join(" "), /JavaScript number/);
  });

  it("rejects effect and post-condition amounts that do not match the quote", () => {
    const effects = plan();
    effects.steps[0]!.expectedAssetEffects = [makeAmount(sbtc, "999")];
    assert.match(validatePlan(effects, quote(), ctx).reasons.join(" "), /expected (asset effect|output)/);

    const send = plan();
    const sendPayload = send.steps[0]?.payload;
    if (sendPayload?.kind !== "stacks_contract_call") throw new Error("expected stacks call");
    sendPayload.postConditions[0]!.amount = makeAmount(sbtc, "1");
    assert.match(validatePlan(send, quote(), ctx).reasons.join(" "), /send post-condition|quote input/);

    const { sender: _sender, ...withoutSender } = ctx;
    const missingSender = validatePlan(plan(), quote(), withoutSender);
    assert.equal(missingSender.ok, false);
    assert.match(missingSender.reasons.join(" "), /sender is required/);
  });

  it("gates wallet presentation behind assertReadyToSign", () => {
    assert.doesNotThrow(() => assertReadyToSign(plan(), quote(), ctx));
    assert.throws(
      () => assertReadyToSign({ ...plan(), quoteId: "other" }, quote(), ctx),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "PLAN_INVALID" &&
        "message" in error &&
        typeof error.message === "string" &&
        /not bound/.test(error.message),
    );
  });
});
