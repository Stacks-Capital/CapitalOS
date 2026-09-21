import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateSbtcWithdrawal,
  fetchEmilyWithdrawal,
  parseEmilyWithdrawal,
  sbtcWithdrawalAvailability,
  withdrawalRecipientScript,
  type BitcoinPayoutObservation,
  type CanonicalWithdrawalCompletion,
  type CanonicalWithdrawalRequest,
  type EmilyWithdrawal,
  type SbtcWithdrawalMetadata,
} from "./withdrawalLifecycle.ts";

const REQUEST_TXID = "11".repeat(32);
const PAYOUT_TXID = "22".repeat(32);
const PAYOUT_BLOCK = "33".repeat(32);
const STACKS_BLOCK = "44".repeat(32);
const COMPLETION_TXID = "55".repeat(32);
const HASH = "66".repeat(20);

const metadata: SbtcWithdrawalMetadata = {
  network: "mainnet",
  requestId: "3359",
  stacksTxid: REQUEST_TXID,
  sender: "SPYEYBKBK5TQ6NW1PAJ3CXCCVAYZ0FE7GMNPVQ60",
  recipientVersion: "04",
  recipientHashbytes: HASH,
  amountSats: "9998137",
  maxSignerFeeSats: "720",
};

const request: CanonicalWithdrawalRequest = {
  requestId: "3359",
  stacksTxid: REQUEST_TXID,
  blockHeight: 9032837,
  blockHash: STACKS_BLOCK,
  amountSats: "9998137",
  maxSignerFeeSats: "720",
  sender: metadata.sender,
  recipientVersion: "04",
  recipientHashbytes: HASH,
  status: null,
  canonical: true,
};

const emily: EmilyWithdrawal = {
  requestId: "3359",
  stacksBlockHash: STACKS_BLOCK,
  stacksBlockHeight: 9032837,
  recipientScript: `0014${HASH}`,
  sender: metadata.sender,
  amountSats: "9998137",
  lastUpdateHeight: 9033141,
  lastUpdateBlockHash: COMPLETION_TXID,
  status: "accepted",
  statusMessage: "Accepted by signer quorum",
  parameters: { maxFeeSats: "720" },
  expectedFulfillment: { bitcoinBlockHeight: 967852, bitcoinTxid: PAYOUT_TXID },
  fulfillment: null,
  txid: REQUEST_TXID,
};

const completion: CanonicalWithdrawalCompletion = {
  requestId: "3359",
  payoutTxid: PAYOUT_TXID,
  payoutOutputIndex: 2,
  feeSats: "46",
  burnBlockHash: PAYOUT_BLOCK,
  burnBlockHeight: 967853,
  sweepTxid: PAYOUT_TXID,
  stacksTxid: COMPLETION_TXID,
  canonical: true,
};

const payout: BitcoinPayoutObservation = {
  txid: PAYOUT_TXID,
  outputIndex: 2,
  amountSats: "9998137",
  scriptPubKey: `0014${HASH}`,
  blockHeight: 967853,
  blockHash: PAYOUT_BLOCK,
  confirmations: 4,
  canonical: true,
  source: "bitcoin-core",
};

describe("K26 sBTC withdrawal lifecycle", () => {
  it("encodes every supported contract recipient into the exact Bitcoin scriptPubKey", () => {
    assert.equal(withdrawalRecipientScript("00", HASH), `76a914${HASH}88ac`);
    assert.equal(withdrawalRecipientScript("01", HASH), `a914${HASH}87`);
    assert.equal(withdrawalRecipientScript("04", HASH), `0014${HASH}`);
    assert.equal(withdrawalRecipientScript("05", "77".repeat(32)), `0020${"77".repeat(32)}`);
    assert.equal(withdrawalRecipientScript("06", "88".repeat(32)), `5120${"88".repeat(32)}`);
    assert.throws(() => withdrawalRecipientScript("07", "88".repeat(32)), /between 00 and 06/);
    assert.throws(() => withdrawalRecipientScript("zz", HASH), /exactly one byte/);
  });

  it("reads Emily by request id and strictly parses its live response shape", async () => {
    let requested = "";
    const parsed = await fetchEmilyWithdrawal({
      network: "mainnet",
      requestId: "3359",
      fetch: async (url) => {
        requested = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            requestId: 3359,
            stacksBlockHash: STACKS_BLOCK,
            stacksBlockHeight: 9032837,
            recipient: `0014${HASH}`,
            sender: metadata.sender,
            amount: 9998137,
            lastUpdateHeight: 9033141,
            lastUpdateBlockHash: COMPLETION_TXID,
            status: "confirmed",
            statusMessage: "Included in canonical block",
            parameters: { maxFee: 720 },
            fulfillment: {
              BitcoinTxid: PAYOUT_TXID,
              BitcoinTxIndex: 2,
              StacksTxid: COMPLETION_TXID,
              BitcoinBlockHash: PAYOUT_BLOCK,
              BitcoinBlockHeight: 967853,
              BtcFee: 46,
            },
            expectedFulfillmentInfo: { bitcoinBlockHeight: 967852, bitcoinTxid: PAYOUT_TXID },
            txid: REQUEST_TXID,
          }),
        };
      },
    });
    assert.equal(requested, "https://sbtc-emily.com/withdrawal/3359");
    assert.equal(parsed?.fulfillment?.btcFeeSats, "46");
    assert.equal(parsed?.amountSats, "9998137");
    assert.throws(
      () =>
        parseEmilyWithdrawal({
          requestId: 3359,
          stacksBlockHash: STACKS_BLOCK,
          stacksBlockHeight: 9032837,
          recipient: `0014${HASH}`,
          sender: metadata.sender,
          amount: 9998137,
          lastUpdateHeight: 9033141,
          lastUpdateBlockHash: COMPLETION_TXID,
          status: "rejected",
          statusMessage: "Rejected by signers",
          parameters: { maxFee: 720 },
          fulfillment: null,
          expectedFulfillmentInfo: { bitcoinBlockHeight: null, bitcoinTxid: null },
          txid: REQUEST_TXID,
        }),
      /Unsupported Emily/,
    );
  });

  it("keeps a delayed signer request pending and never authorizes a duplicate", () => {
    const lifecycle = evaluateSbtcWithdrawal({
      metadata,
      request,
      emily: null,
      completion: null,
      payout: null,
      providerTimedOut: true,
    });
    assert.equal(lifecycle.state, "signer_processing");
    assert.equal(lifecycle.broadcastAllowed, false);
    assert.equal(lifecycle.nextAction, "WAIT");
    assert.match(lifecycle.warnings.join(" "), /existing request remains pending/);
  });

  it("labels Emily's expected transaction and height as estimates while waiting", () => {
    const lifecycle = evaluateSbtcWithdrawal({ metadata, request, emily, completion: null, payout: null });
    assert.equal(lifecycle.state, "signer_processing");
    assert.equal(lifecycle.signer.expectedPayoutTxid, PAYOUT_TXID);
    assert.equal(lifecycle.signer.expectedPayoutBlockHeight, 967852);
    assert.equal(lifecycle.accounting.actualSignerFeeSats, null);
    assert.equal(lifecycle.accounting.finalSbtcDebitSats, null);
  });

  it("reconciles canonical debit, fee refund and the exact Bitcoin payout", () => {
    const confirmedEmily: EmilyWithdrawal = {
      ...emily,
      status: "confirmed",
      statusMessage: "Included in canonical block",
      fulfillment: {
        bitcoinTxid: PAYOUT_TXID,
        bitcoinTxOutputIndex: 2,
        stacksTxid: COMPLETION_TXID,
        bitcoinBlockHash: PAYOUT_BLOCK,
        bitcoinBlockHeight: 967853,
        btcFeeSats: "46",
      },
    };
    const lifecycle = evaluateSbtcWithdrawal({
      metadata,
      request: { ...request, status: true },
      emily: confirmedEmily,
      completion,
      payout,
    });
    assert.equal(lifecycle.state, "reconciled");
    assert.equal(lifecycle.complete, true);
    assert.deepEqual(lifecycle.accounting, {
      withdrawalAmountSats: "9998137",
      maximumSignerFeeSats: "720",
      initiallyLockedSats: "9998857",
      actualSignerFeeSats: "46",
      finalSbtcDebitSats: "9998183",
      refundedSbtcSats: "674",
      returnedAfterRejectionSats: null,
      bitcoinReceivedSats: "9998137",
    });
  });

  it("fails closed when the Bitcoin amount, recipient or canonical completion differs", () => {
    const lifecycle = evaluateSbtcWithdrawal({
      metadata,
      request: { ...request, status: true },
      emily,
      completion,
      payout: { ...payout, amountSats: "9998136", scriptPubKey: `0014${"99".repeat(20)}` },
    });
    assert.equal(lifecycle.state, "reconciliation_failed");
    assert.equal(lifecycle.complete, false);
    assert.match(lifecycle.warnings.join(" "), /payout amount.*payout recipient/);
  });

  it("does not reconcile a disputed signer fee or contradictory signer status", () => {
    const fulfillment: NonNullable<EmilyWithdrawal["fulfillment"]> = {
      bitcoinTxid: PAYOUT_TXID,
      bitcoinTxOutputIndex: 2,
      stacksTxid: COMPLETION_TXID,
      bitcoinBlockHash: PAYOUT_BLOCK,
      bitcoinBlockHeight: 967853,
      btcFeeSats: "47",
    };
    const disputed = evaluateSbtcWithdrawal({
      metadata,
      request: { ...request, status: true },
      emily: { ...emily, status: "confirmed", fulfillment },
      completion,
      payout,
    });
    assert.equal(disputed.state, "reconciliation_failed");
    assert.equal(disputed.accounting.finalSbtcDebitSats, null);
    assert.match(disputed.warnings.join(" "), /canonical completion: fee/);

    const contradictory = evaluateSbtcWithdrawal({
      metadata,
      request: { ...request, status: true },
      emily: { ...emily, status: "failed" },
      completion,
      payout,
    });
    assert.equal(contradictory.state, "reconciliation_failed");
    assert.match(contradictory.warnings.join(" "), /signer failure contradicts/);
  });

  it("waits for a confirmed Bitcoin payout before finalizing the sBTC debit", () => {
    const pending = evaluateSbtcWithdrawal({
      metadata,
      request: { ...request, status: true },
      emily,
      completion,
      payout: { ...payout, confirmations: 0 },
    });
    assert.equal(pending.state, "payout_confirming");
    assert.equal(pending.complete, false);
    assert.equal(pending.accounting.finalSbtcDebitSats, null);
    assert.match(pending.warnings.join(" "), /no confirmation yet/);
  });

  it("waits for canonical unlock after signer failure, then completes as recovered rejection", () => {
    const pending = evaluateSbtcWithdrawal({
      metadata,
      request,
      emily: { ...emily, status: "failed", statusMessage: "Rejected by signers" },
      completion: null,
      payout: null,
    });
    assert.equal(pending.state, "signer_rejection_pending");
    assert.equal(pending.complete, false);

    const recovered = evaluateSbtcWithdrawal({
      metadata,
      request: { ...request, status: false },
      emily: { ...emily, status: "failed", statusMessage: "Rejected by signers" },
      completion: null,
      payout: null,
    });
    assert.equal(recovered.state, "rejected");
    assert.equal(recovered.complete, true);
    assert.equal(recovered.accounting.returnedAfterRejectionSats, "9998857");
    assert.equal(recovered.accounting.finalSbtcDebitSats, null);
  });

  it("rebuilds the same resumable state from JSON-persisted evidence", () => {
    const input = { metadata, request, emily, completion: null, payout: null };
    const before = evaluateSbtcWithdrawal(input);
    const after = evaluateSbtcWithdrawal(JSON.parse(JSON.stringify(input)) as typeof input);
    assert.equal(after.transferId, before.transferId);
    assert.equal(after.state, before.state);
    assert.equal(after.broadcastAllowed, false);
  });

  it("returns a truthful unavailable state on unsupported testnet", () => {
    assert.equal(sbtcWithdrawalAvailability("testnet").available, false);
    const lifecycle = evaluateSbtcWithdrawal({
      metadata: { ...metadata, network: "testnet" },
      request: null,
      emily: null,
      completion: null,
      payout: null,
    });
    assert.equal(lifecycle.state, "unavailable");
    assert.equal(lifecycle.nextAction, "NONE");
    assert.match(lifecycle.availability.reason ?? "", /mismatch/i);
  });
});
