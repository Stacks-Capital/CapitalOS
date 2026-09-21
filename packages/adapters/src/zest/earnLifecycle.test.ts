import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assetsForShares,
  evaluateZestEarn,
  sharesForAssets,
  valueZestReceipt,
  zestEarnTransferId,
  zestSupplyApr,
  type ZestEarnIntent,
  type ZestVaultMarketEvidence,
} from "./earnLifecycle.ts";

const OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
const NOW = "2026-09-15T12:00:00.000Z";

const market: ZestVaultMarketEvidence = {
  totalAssets: "66022279734",
  availableAssets: "66022279734",
  capSupply: "500000000000",
  interestRateBps: "130",
  shareRateNumerator: "2",
  shareRateDenominator: "3",
  pausedDeposit: false,
  pausedRedeem: false,
  observedAt: NOW,
  source: "hiro-read",
  blockHeight: 8_993_830,
  blockHash: "0xabc",
};

const supplyIntent: ZestEarnIntent = {
  action: "supply",
  network: "mainnet",
  owner: OWNER,
  amount: "100",
  minOut: "66",
  recipient: OWNER,
  idempotencyKey: "supply-1",
};

describe("K27 Zest supply and withdrawal lifecycle", () => {
  it("keeps the transfer id stable across reloads and never allows a second broadcast", () => {
    assert.equal(zestEarnTransferId("mainnet", "supply", "supply-1"), "mainnet:zest:supply:supply-1");
    const lifecycle = evaluateZestEarn({
      intent: supplyIntent,
      market,
      settlement: null,
      shares: null,
      broadcastKnown: false,
    });
    assert.equal(lifecycle.broadcastAllowed, false);
    assert.equal(lifecycle.state, "awaiting_signature");
    assert.equal(lifecycle.transferId, "mainnet:zest:supply:supply-1");
  });

  it("treats get-interest-rate as protocol basis points and refuses invented APY", () => {
    const apr = zestSupplyApr("130");
    assert.equal(apr.rateBps, "130");
    assert.equal(apr.scale, 4);
    assert.equal(apr.rankingAllowed, true);
    assert.match(apr.meaning, /does not annualise/);
    assert.equal(zestSupplyApr(null).projectedEarningsAllowed, false);
  });

  it("converts shares and assets with floor rounding and never double-counts the receipt", () => {
    assert.equal(sharesForAssets("100", market), "66");
    assert.equal(assetsForShares("66", market), "99");
    const valued = valueZestReceipt("77", market, "mainnet");
    assert.equal(valued.underlyingUnits, "115");
    assert.equal(valued.countsReceiptTowardPortfolio, false);
    assert.match(valued.note, /once/);
    assert.equal(valueZestReceipt("77", null, "mainnet").underlyingUnits, null);
  });

  it("reconciles a canonical supply against the rounded share preview", () => {
    const lifecycle = evaluateZestEarn({
      intent: supplyIntent,
      market,
      settlement: {
        kind: "zest_deposit",
        stacksTxid: "0x11",
        blockHeight: 8_993_831,
        blockHash: "0xdef",
        canonical: true,
        assetsMoved: "100",
        sharesMoved: "66",
        owner: OWNER,
      },
      shares: { shareBalance: "66", source: "hiro-read" },
      broadcastKnown: true,
    });
    assert.equal(lifecycle.state, "reconciled");
    assert.equal(lifecycle.complete, true);
    assert.equal(lifecycle.apr.rateBps, "130");
    assert.equal(lifecycle.valuation.underlyingUnits, "99");
    assert.equal(lifecycle.valuation.countsReceiptTowardPortfolio, false);
  });

  it("fails closed when minted shares disagree with the preview", () => {
    const lifecycle = evaluateZestEarn({
      intent: supplyIntent,
      market,
      settlement: {
        kind: "zest_deposit",
        stacksTxid: "0x11",
        blockHeight: 8_993_831,
        blockHash: "0xdef",
        canonical: true,
        assetsMoved: "100",
        sharesMoved: "65",
        owner: OWNER,
      },
      shares: { shareBalance: "65", source: "hiro-read" },
      broadcastKnown: true,
    });
    assert.equal(lifecycle.state, "reconciliation_failed");
    assert.equal(lifecycle.nextAction, "CONTACT_SUPPORT");
    assert.match(lifecycle.warnings.join(" "), /shares minted/);
  });

  it("reconciles a redeem that meets min-out and blocks one that does not", () => {
    const redeemIntent: ZestEarnIntent = {
      action: "withdraw_supply",
      network: "mainnet",
      owner: OWNER,
      amount: "66",
      minOut: "99",
      recipient: OWNER,
      idempotencyKey: "redeem-1",
    };
    const ok = evaluateZestEarn({
      intent: redeemIntent,
      market,
      settlement: {
        kind: "zest_redeem",
        stacksTxid: "0x22",
        blockHeight: 8_993_832,
        blockHash: "0xfe",
        canonical: true,
        assetsMoved: "99",
        sharesMoved: "66",
        owner: OWNER,
      },
      shares: { shareBalance: "0", source: "hiro-read" },
      broadcastKnown: true,
    });
    assert.equal(ok.state, "reconciled");

    const short = evaluateZestEarn({
      intent: redeemIntent,
      market,
      settlement: {
        kind: "zest_redeem",
        stacksTxid: "0x22",
        blockHeight: 8_993_832,
        blockHash: "0xfe",
        canonical: true,
        assetsMoved: "98",
        sharesMoved: "66",
        owner: OWNER,
      },
      shares: { shareBalance: "0", source: "hiro-read" },
      broadcastKnown: true,
    });
    assert.equal(short.state, "reconciliation_failed");
    assert.match(short.warnings.join(" "), /below min-out/);
  });

  it("exposes pause, cap, testnet unavailable and missing-market states truthfully", () => {
    assert.equal(
      evaluateZestEarn({
        intent: supplyIntent,
        market: { ...market, pausedDeposit: true },
        settlement: null,
        shares: null,
        broadcastKnown: false,
      }).state,
      "paused",
    );
    assert.equal(
      evaluateZestEarn({
        intent: { ...supplyIntent, amount: "500000000001" },
        market,
        settlement: null,
        shares: null,
        broadcastKnown: false,
      }).state,
      "cap_blocked",
    );
    assert.equal(
      evaluateZestEarn({
        intent: { ...supplyIntent, network: "testnet" },
        market,
        settlement: null,
        shares: null,
        broadcastKnown: false,
      }).state,
      "unavailable",
    );
    assert.equal(
      evaluateZestEarn({
        intent: supplyIntent,
        market: null,
        settlement: null,
        shares: null,
        broadcastKnown: false,
      }).state,
      "unavailable",
    );
  });
});
