import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateDepositAccounting,
  calculateWithdrawalAccounting,
  findLatestSbtcWorkflow,
  isAttemptBroadcastUnknown,
  stageForDeposit,
  stageForWithdrawal,
  validateBtcRecipient,
} from "./sbtc.ts";

describe("sBTC bridge and withdrawal UI utilities", () => {
  describe("stage mapping", () => {
    it("never badges incomplete deposit states as done", () => {
      assert.equal(stageForDeposit("SUBMITTED"), "confirming");
      assert.equal(stageForDeposit("CONFIRMING"), "confirming");
      assert.equal(stageForDeposit("SIGNER_PROCESSING"), "confirming");
      assert.equal(stageForDeposit("MINT_PENDING"), "confirming");
      assert.equal(stageForDeposit("RECLAIMABLE"), "reclaim");
      assert.equal(stageForDeposit("RECONCILING"), "confirming");
      assert.equal(stageForDeposit("RECONCILED"), "done");
      assert.equal(stageForDeposit("COMPLETED"), "done");
      assert.equal(stageForDeposit("BROADCAST_UNKNOWN"), "recovery");
      assert.equal(stageForDeposit("RECONCILIATION_FAILED"), "recovery");
    });

    it("maps withdrawal states correctly, treating signer failure as recovery", () => {
      assert.equal(stageForWithdrawal("AWAITING_SIGNATURE"), "signing");
      assert.equal(stageForWithdrawal("SUBMITTED"), "confirming");
      assert.equal(stageForWithdrawal("REQUEST_CONFIRMING"), "confirming");
      assert.equal(stageForWithdrawal("SIGNER_PROCESSING"), "confirming");
      assert.equal(stageForWithdrawal("PAYOUT_CONFIRMING"), "confirming");
      assert.equal(stageForWithdrawal("SIGNER_REJECTION_PENDING"), "recovery");
      assert.equal(stageForWithdrawal("RECONCILED"), "done");
      assert.equal(stageForWithdrawal("COMPLETED"), "done");
      assert.equal(stageForWithdrawal("BROADCAST_UNKNOWN"), "recovery");
      assert.equal(stageForWithdrawal("REJECTED"), "recovery");
    });
  });

  describe("recipient validation", () => {
    it("validates P2WPKH version 04 with 20-byte hash", () => {
      const valid = validateBtcRecipient("04:00112233445566778899aabbccddeeff00112233");
      assert.equal(valid.valid, true);
      assert.equal(valid.version, "04");
      assert.equal(valid.hashbytes, "00112233445566778899aabbccddeeff00112233");
    });

    it("validates P2TR version 06 with 32-byte hash", () => {
      const hash32 = "aa".repeat(32);
      const valid = validateBtcRecipient(`06:${hash32}`);
      assert.equal(valid.valid, true);
      assert.equal(valid.version, "06");
      assert.equal(valid.hashbytes, hash32);
    });

    it("rejects invalid versions or wrong length hashes", () => {
      assert.equal(validateBtcRecipient("").valid, false);
      assert.equal(validateBtcRecipient("not-a-recipient").valid, false);
      assert.equal(validateBtcRecipient("07:001122").valid, false); // version 07 not supported
      assert.equal(validateBtcRecipient("04:001122").valid, false); // too short for 04
      assert.equal(validateBtcRecipient("06:001122").valid, false); // too short for 06
    });
  });

  describe("accounting calculations", () => {
    it("calculates deposit accounting accurately", () => {
      const acc = calculateDepositAccounting({ amountSats: "100000", maxFeeSats: "2000" });
      assert.equal(acc.depositAmountSats, "100000");
      assert.equal(acc.maxSignerFeeSats, "2000");
      assert.equal(acc.minExpectedSbtcSats, "98000");
    });

    it("calculates withdrawal accounting with initially locked and refund", () => {
      const acc = calculateWithdrawalAccounting({
        amountSats: "500000",
        maxFeeSats: "10000",
        actualFeeSats: "4000",
        bitcoinReceivedSats: "500000",
      });
      assert.equal(acc.withdrawalAmountSats, "500000");
      assert.equal(acc.maximumSignerFeeSats, "10000");
      assert.equal(acc.initiallyLockedSats, "510000");
      assert.equal(acc.actualSignerFeeSats, "4000");
      assert.equal(acc.finalSbtcDebitSats, "504000");
      assert.equal(acc.refundedSbtcSats, "6000");
      assert.equal(acc.bitcoinReceivedSats, "500000");
    });

    it("refuses negative fees or zero amounts", () => {
      assert.throws(() => calculateDepositAccounting({ amountSats: "0", maxFeeSats: "100" }), /positive/);
      assert.throws(() => calculateWithdrawalAccounting({ amountSats: "-1", maxFeeSats: "100" }), /positive/);
    });
  });

  describe("workflow discovery and broadcast safety", () => {
    it("finds the latest workflow by action", () => {
      const workflows = [
        {
          id: "wf_1",
          network: "mainnet" as const,
          state: "COMPLETED",
          nextAction: "DONE",
          quoteId: null,
          planId: null,
          action: "withdraw_sbtc",
          createdAt: "2026-09-20T10:00:00Z",
          updatedAt: "2026-09-20T11:00:00Z",
          transitionCount: 2,
        },
        {
          id: "wf_2",
          network: "mainnet" as const,
          state: "SUBMITTED",
          nextAction: "WAIT",
          quoteId: null,
          planId: null,
          action: "withdraw_sbtc",
          createdAt: "2026-09-21T10:00:00Z",
          updatedAt: "2026-09-21T11:00:00Z",
          transitionCount: 1,
        },
        {
          id: "wf_3",
          network: "mainnet" as const,
          state: "SUBMITTED",
          nextAction: "WAIT",
          quoteId: null,
          planId: null,
          action: "deposit_sbtc",
          createdAt: "2026-09-21T12:00:00Z",
          updatedAt: "2026-09-21T12:00:00Z",
          transitionCount: 1,
        },
      ];

      const latestWithdraw = findLatestSbtcWorkflow(workflows, "withdraw_sbtc");
      assert.equal(latestWithdraw?.id, "wf_2");

      const latestDeposit = findLatestSbtcWorkflow(workflows, "deposit_sbtc");
      assert.equal(latestDeposit?.id, "wf_3");
    });

    it("flags missing txid or unknown outcome as needing investigation", () => {
      assert.equal(isAttemptBroadcastUnknown(undefined), true);
      assert.equal(isAttemptBroadcastUnknown({ outcome: "UNKNOWN", txid: "0x123" }), true);
      assert.equal(isAttemptBroadcastUnknown({ outcome: "BROADCAST", txid: null }), true);
      assert.equal(isAttemptBroadcastUnknown({ outcome: "BROADCAST", txid: "" }), true);
      assert.equal(isAttemptBroadcastUnknown({ outcome: "BROADCAST", txid: "0xabc" }), false);
    });
  });
});
