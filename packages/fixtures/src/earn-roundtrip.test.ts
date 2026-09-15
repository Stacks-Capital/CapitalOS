import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityFor } from "@stacks-capital/config";
import {
  assertValidPlan,
  canSubmitWrite,
  createWorkflow,
  recordUnknownBroadcast,
  transition,
  walletOutcome,
} from "@stacks-capital/core";
import { adapterContext, sandboxAdapters } from "./index.ts";

function walkConfirmed(id: string) {
  let flow = createWorkflow({ id, network: "mainnet", idempotencyKey: id });
  flow = transition(flow, "QUOTED", { reason: "quote", actor: "sdk", evidence: "quote" });
  flow = transition(flow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: "plan" });
  flow = transition(flow, "SUBMITTED", { reason: "txid", actor: "wallet", evidence: "0xabc" });
  flow = transition(flow, "CONFIRMING", { reason: "included", actor: "worker", evidence: "block" });
  flow = transition(flow, "STEP_CONFIRMED", { reason: "event", actor: "adapter", evidence: "event" });
  flow = transition(flow, "RECONCILING", { reason: "read", actor: "adapter", evidence: "position" });
  flow = transition(flow, "COMPLETED", { reason: "matched", actor: "adapter", evidence: "delta" });
  return flow;
}

describe("K10 earn round trip", () => {
  it("deposits BTC to sBTC, supplies Zest, redeems, then requests withdrawal without compressing cross-chain states", () => {
    const ctx = adapterContext("mainnet");
    const { deposit, zest, withdraw } = sandboxAdapters("mainnet");
    const owner = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";

    const depositQuote = deposit.quote(ctx, { action: "deposit_sbtc", marketId: "sbtc.deposit", amount: "100000000", recipient: owner, maxFee: "1000" });
    const depositPlan = deposit.buildPlan(ctx, depositQuote, { action: "deposit_sbtc", marketId: "sbtc.deposit", amount: "100000000", recipient: owner, maxFee: "1000" });
    assertValidPlan(depositPlan, depositQuote, { now: ctx.now, network: "mainnet", registryVersion: ctx.registryVersion, sender: owner });
    assert.equal(depositPlan.steps[0]?.payload.kind, "bitcoin_deposit");
    const minted = deposit.reconcile(ctx, "99999000", "99999000");
    assert.equal(minted.matched, true);
    assert.equal(walkConfirmed("wf_deposit").state, "COMPLETED");

    const supplyQuote = zest.quote(ctx, { action: "supply", marketId: "zest.sbtc.vault", amount: "99999000" });
    const supplyPlan = zest.buildPlan(ctx, supplyQuote, { action: "supply", marketId: "zest.sbtc.vault", amount: "99999000" });
    assertValidPlan(supplyPlan, supplyQuote, { now: ctx.now, network: "mainnet", registryVersion: ctx.registryVersion, sender: owner });
    assert.equal(zest.explainRisk(ctx, "zest.sbtc.vault").disclosures.some((line) => line.includes("not a second asset")), true);
    assert.equal(walkConfirmed("wf_supply").state, "COMPLETED");

    const redeemQuote = zest.quote(ctx, { action: "withdraw_supply", marketId: "zest.sbtc.vault", amount: "99999000", minOut: "99999000" });
    const redeemPlan = zest.buildPlan(ctx, redeemQuote, { action: "withdraw_supply", marketId: "zest.sbtc.vault", amount: "99999000", minOut: "99999000" });
    assertValidPlan(redeemPlan, redeemQuote, { now: ctx.now, network: "mainnet", registryVersion: ctx.registryVersion, sender: owner });
    assert.equal(walkConfirmed("wf_redeem").state, "COMPLETED");

    const recipient = "04:00112233445566778899aabbccddeeff00112233";
    const withdrawQuote = withdraw.quote(ctx, { action: "withdraw_sbtc", marketId: "sbtc.withdraw", amount: "99999000", recipient, maxFee: "1000" });
    withdraw.buildPlan(ctx, withdrawQuote, { action: "withdraw_sbtc", marketId: "sbtc.withdraw", amount: "99999000", recipient, maxFee: "1000" });
    let withdrawal = createWorkflow({ id: "wf_withdraw", network: "mainnet", idempotencyKey: "wd" });
    withdrawal = transition(withdrawal, "QUOTED", { reason: "quote", actor: "sdk", evidence: withdrawQuote.id });
    withdrawal = transition(withdrawal, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: "initiate" });
    withdrawal = transition(withdrawal, "SUBMITTED", { reason: "stacks tx", actor: "wallet", evidence: "0xstacks" });
    withdrawal = transition(withdrawal, "CONFIRMING", { reason: "stacks confirmed", actor: "worker", evidence: "request-id" });
    withdrawal = transition(withdrawal, "STEP_CONFIRMED", { reason: "request created", actor: "adapter", evidence: "not payout" });
    assert.notEqual(withdrawal.state, "COMPLETED");
    assert.match(withdrawQuote.warnings.join(" "), /Bitcoin payout/);
  });

  it("keeps staking and testnet sBTC deposit disabled", () => {
    assert.equal(capabilityFor("stake", "mainnet")?.state, "disabled");
    assert.equal(capabilityFor("deposit_sbtc", "testnet")?.state, "disabled");
  });

  it("treats an empty txid as unknown and blocks a write retry", () => {
    let flow = createWorkflow({ id: "wf_unknown", network: "mainnet", idempotencyKey: "u" });
    flow = transition(flow, "QUOTED", { reason: "q", actor: "sdk", evidence: "q" });
    flow = transition(flow, "AWAITING_SIGNATURE", { reason: "p", actor: "sdk", evidence: "p" });
    assert.equal(walletOutcome({ txid: "" }), "UNKNOWN");
    flow = recordUnknownBroadcast(flow, "txid empty");
    assert.equal(canSubmitWrite(flow.state), false);
    assert.equal(flow.nextAction, "RETRY_READ");
  });
});
