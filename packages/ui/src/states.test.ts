import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attemptTxid, canSign, contractOf, type QuoteView } from "./earn.ts";
import { excludedFrom, type Portfolio } from "./holdings.ts";
import { explorerTxUrl, workflowAnnouncement, type WorkflowProgress } from "./shell.ts";
import { CANONICAL_STATE_KINDS, type CanonicalState } from "./state.ts";

function fakeQuoteView(overrides: Partial<QuoteView>): QuoteView {
  return {
    input: "100 sBTC",
    expected: "100 zsBTC",
    fees: [],
    minimumOutput: null,
    warnings: [],
    expiresInSeconds: 60,
    expired: false,
    executable: true,
    ...overrides,
  };
}

describe("Canonical State Kinds and Pure Helpers (Task I31)", () => {
  it("declares all eight canonical state kinds in the contract", () => {
    assert.equal(CANONICAL_STATE_KINDS.length, 8);
    assert.deepEqual(CANONICAL_STATE_KINDS, [
      "loading",
      "empty",
      "partial",
      "unsupported",
      "stale_disputed",
      "review",
      "submitted",
      "failed_delayed",
    ]);
  });

  describe("canSign (Quote Execution Guard)", () => {
    it("permits signing only when quote is executable and not expired", () => {
      assert.equal(canSign(fakeQuoteView({ executable: true, expired: false })), true);
      assert.equal(canSign(fakeQuoteView({ executable: false, expired: false })), false);
      assert.equal(canSign(fakeQuoteView({ executable: true, expired: true })), false);
      assert.equal(canSign(fakeQuoteView({ executable: false, expired: true })), false);
    });
  });

  describe("attemptTxid (Transaction Recovery Helper)", () => {
    it("returns null when attempts array is empty", () => {
      assert.equal(attemptTxid([]), null);
    });

    it("returns the latest non-null transaction id", () => {
      const attempts = [
        { stepId: "step_1", outcome: "BROADCAST" as const, txid: "0x1111" },
        { stepId: "step_2", outcome: "BROADCAST" as const, txid: "0x2222" },
      ];
      assert.equal(attemptTxid(attempts), "0x2222");
    });

    it("returns null when attempts exist but none produced a txid (unknown broadcast)", () => {
      const attempts = [{ stepId: "step_1", outcome: "BROADCAST" as const, txid: null }];
      assert.equal(attemptTxid(attempts), null);
    });

    it("skips attempts with null txid to find the latest valid broadcast", () => {
      const attempts = [
        { stepId: "step_1", outcome: "BROADCAST" as const, txid: "0x1111" },
        { stepId: "step_2", outcome: "UNKNOWN" as const, txid: null },
      ];
      assert.equal(attemptTxid(attempts), "0x1111");
    });
  });

  describe("contractOf (Plan Step Contract Extraction)", () => {
    it("extracts the contractId from the first step payload", () => {
      const steps = [{ payload: { contractId: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zest-vault" } }];
      assert.equal(contractOf(steps), "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zest-vault");
    });

    it("falls back safely when steps are empty", () => {
      assert.equal(contractOf([]), "not named by the plan");
    });

    it("falls back safely when contractId is missing or not a string", () => {
      assert.equal(contractOf([{ payload: {} }]), "not named by the plan");
      assert.equal(contractOf([{ payload: { contractId: 12345 } }]), "not named by the plan");
    });
  });

  describe("excludedFrom (Partial State Reasons)", () => {
    it("identifies positions omitted because they are represented by protocol positions", () => {
      const portfolio: Portfolio = {
        rows: [
          {
            key: "row_receipt",
            kind: "receipt",
            assetId: "zsBTC",
            quantity: "100",
            marketId: "zest.sbtc-v2",
            countsTowardTotal: false,
            stale: false,
            warnings: [],
          },
        ],
        totals: [],
      };
      const excluded = excludedFrom(portfolio);
      assert.equal(excluded.length, 1);
      assert.equal(excluded[0]?.name, "zsBTC in zest.sbtc-v2");
      assert.equal(excluded[0]?.reason, "already counted through the protocol position it represents");
    });

    it("identifies positions omitted because provider returned no quantity", () => {
      const portfolio: Portfolio = {
        rows: [
          {
            key: "row_empty_stx",
            kind: "wallet",
            assetId: "STX",
            quantity: null,
            marketId: null,
            countsTowardTotal: true,
            stale: false,
            warnings: [],
          },
        ],
        totals: [],
      };
      const excluded = excludedFrom(portfolio);
      assert.equal(excluded.length, 1);
      assert.equal(excluded[0]?.name, "STX");
      assert.equal(excluded[0]?.reason, "the provider returned no quantity, and zero is a real balance");
    });

    it("returns an empty array when all counted rows have verified quantities", () => {
      const portfolio: Portfolio = {
        rows: [
          {
            key: "row_stx",
            kind: "wallet",
            assetId: "STX",
            quantity: "5000000",
            marketId: null,
            countsTowardTotal: true,
            stale: false,
            warnings: [],
          },
        ],
        totals: [{ assetId: "STX", quantity: "5000000", incomplete: false, warnings: [] }],
      };
      assert.deepEqual(excludedFrom(portfolio), []);
    });
  });

  describe("workflowAnnouncement (Screen Reader Live Region)", () => {
    it("announces nothing when there are no workflows", () => {
      assert.equal(workflowAnnouncement([]), "");
    });

    it("announces the newest workflow formatted with spaces and lowercase state", () => {
      const workflows: WorkflowProgress[] = [
        { id: "wf_987", action: "Supply sBTC", state: "SIGNER_PROCESSING" },
        { id: "wf_123", action: "Borrow USDCx", state: "CONFIRMED" },
      ];
      assert.equal(workflowAnnouncement(workflows), "Supply sBTC wf_987 is signer processing.");
    });

    it("falls back to generic Workflow label when action is not provided", () => {
      const workflows: WorkflowProgress[] = [{ id: "wf_abc", state: "SUBMITTED" }];
      assert.equal(workflowAnnouncement(workflows), "Workflow wf_abc is submitted.");
    });
  });

  describe("explorerTxUrl (Explorer Links)", () => {
    it("generates mainnet Hiro explorer URL", () => {
      assert.equal(
        explorerTxUrl("0xabcdef123456", "mainnet"),
        "https://explorer.hiro.so/txid/0xabcdef123456?chain=mainnet",
      );
    });

    it("generates testnet Hiro explorer URL", () => {
      assert.equal(
        explorerTxUrl("0x9876543210", "testnet"),
        "https://explorer.hiro.so/txid/0x9876543210?chain=testnet",
      );
    });

    it("URL encodes special characters in transaction IDs", () => {
      assert.equal(
        explorerTxUrl("tx with spaces", "testnet"),
        "https://explorer.hiro.so/txid/tx%20with%20spaces?chain=testnet",
      );
    });
  });

  describe("CanonicalState polymorphic mapping", () => {
    it("supports all eight states through the CanonicalState union", () => {
      const states: CanonicalState[] = [
        { kind: "loading", what: "positions" },
        { kind: "empty", instruction: "Sign in" },
        { kind: "partial", verifiedSubtotal: "100", assetUnit: "sBTC", excludedPositions: [] },
        { kind: "unsupported", assetOrProtocol: "Stacking", reason: "Disabled" },
        { kind: "stale_disputed", ageDescription: "10m", sources: ["pyth"] },
        {
          kind: "review",
          giveAmount: "1",
          giveAsset: "sBTC",
          receiveAmount: "1",
          receiveAsset: "sBTC",
          fees: [],
          protocol: "Zest",
          contract: "SP1.vault",
          planValidated: true,
        },
        { kind: "submitted", txId: "0x123", explorerUrl: "https://explorer" },
        { kind: "failed_delayed", cause: "timeout", fundsLocation: "wallet", recovery: [] },
      ];
      assert.deepEqual(
        states.map((s) => s.kind),
        CANONICAL_STATE_KINDS,
      );
    });
  });
});
