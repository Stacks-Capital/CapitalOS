import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterReads } from "../reads.ts";
import {
  evaluateGraniteCredit,
  marketFromReads,
  settleGraniteRepay,
  type GraniteCreditIntent,
  type GraniteMarketEvidence,
  type GranitePositionEvidence,
} from "./creditLifecycle.ts";

const OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const oracle = {
  sbtc: {
    price: "10000000000000",
    scale: "8",
    observedAt: "2026-09-15T11:59:00.000Z",
    source: "fixture",
    stale: false,
    maxAgeMs: 180_000,
  },
  usdcx: {
    price: "100000000",
    scale: "8",
    observedAt: "2026-09-15T11:59:00.000Z",
    source: "fixture",
    stale: false,
    maxAgeMs: 180_000,
  },
};

const market: GraniteMarketEvidence = {
  borrowPaused: false,
  repayPaused: false,
  liquidityUsdcx: "250000000000",
  interestRateBps: "400",
  riskParams: {
    ltvBorrowBps: "7000",
    ltvLiqBps: "8000",
    bufferBps: "500",
    sbtcDecimals: "8",
    usdcxDecimals: "6",
  },
  oracle,
};

const position: GranitePositionEvidence = {
  collateral: "100000000",
  debt: "10000000",
  accruedDebt: "10050000",
  observedAt: "2026-09-15T12:00:00.000Z",
  source: "fixture",
};

const borrowIntent: GraniteCreditIntent = {
  action: "borrow",
  network: "mainnet",
  owner: OWNER,
  amount: "5000000",
  idempotencyKey: "borrow-1",
};

describe("K32 Granite credit lifecycle", () => {
  it("settles repay-all against accrued debt and refuses overpay", () => {
    assert.deepEqual(settleGraniteRepay("max", position), {
      amount: "10050000",
      isRepayAll: true,
      accruedDebt: "10050000",
    });
    assert.equal("error" in settleGraniteRepay("10050001", position), true);
  });

  it("reconciles a canonical borrow and keeps broadcast disabled", () => {
    const lifecycle = evaluateGraniteCredit({
      intent: borrowIntent,
      market,
      position,
      settlement: {
        kind: "granite_borrow",
        stacksTxid: "0x11",
        blockHeight: 1,
        blockHash: "0x22",
        canonical: true,
        assetMoved: "5000000",
        owner: OWNER,
      },
      broadcastKnown: true,
      now: NOW,
    });
    assert.equal(lifecycle.state, "reconciled");
    assert.equal(lifecycle.complete, true);
    assert.equal(lifecycle.broadcastAllowed, false);
    assert.equal(lifecycle.health.stale, false);
    assert.match(lifecycle.contracts.market, /v0-8-market/);
  });

  it("reconciles repay-all to the accrued amount and reports remaining debt zero", () => {
    const lifecycle = evaluateGraniteCredit({
      intent: { ...borrowIntent, action: "repay", amount: "max", idempotencyKey: "repay-all" },
      market,
      position,
      settlement: {
        kind: "granite_repay",
        stacksTxid: "0x33",
        blockHeight: 2,
        blockHash: "0x44",
        canonical: true,
        assetMoved: "10050000",
        owner: OWNER,
      },
      broadcastKnown: true,
      now: NOW,
    });
    assert.equal(lifecycle.state, "reconciled");
    assert.equal(lifecycle.repay.isRepayAll, true);
    assert.equal(lifecycle.repay.settledAmount, "10050000");
    assert.equal(lifecycle.repay.remainingDebt, "0");
  });

  it("fails closed on stale oracle, pause, liquidity and health boundaries", () => {
    assert.equal(
      evaluateGraniteCredit({
        intent: borrowIntent,
        market: {
          ...market,
          oracle: {
            ...oracle,
            sbtc: { ...oracle.sbtc, observedAt: "2026-09-15T11:00:00.000Z" },
          },
        },
        position,
        settlement: null,
        broadcastKnown: false,
        now: NOW,
      }).state,
      "oracle_stale",
    );
    assert.equal(
      evaluateGraniteCredit({
        intent: borrowIntent,
        market: { ...market, borrowPaused: true },
        position,
        settlement: null,
        broadcastKnown: false,
        now: NOW,
      }).state,
      "paused",
    );
    assert.equal(
      evaluateGraniteCredit({
        intent: { ...borrowIntent, amount: "250000000001" },
        market,
        position,
        settlement: null,
        broadcastKnown: false,
        now: NOW,
      }).state,
      "liquidity_blocked",
    );
    assert.equal(
      evaluateGraniteCredit({
        intent: borrowIntent,
        market,
        position: { ...position, collateral: "0", debt: "0", accruedDebt: "0" },
        settlement: null,
        broadcastKnown: false,
        now: NOW,
      }).state,
      "health_blocked",
    );
  });

  it("builds market evidence from adapter reads and rejects missing oracles", () => {
    const reads: AdapterReads = {
      emilyLimits: { perDepositMinimum: "1000", perWithdrawalCap: "1" },
      oracle,
      riskParams: market.riskParams,
      debtVault: {
        pausedDeposit: false,
        pausedRedeem: false,
        totalAssets: "250000000000",
        capSupply: "500000000000",
        shareRateNumerator: "1",
        shareRateDenominator: "1",
        interestRateBps: "400",
      },
    };
    const loaded = marketFromReads(reads, NOW);
    assert.equal("error" in loaded, false);
    if (!("error" in loaded)) assert.equal(loaded.liquidityUsdcx, "250000000000");
    assert.equal("error" in marketFromReads({ emilyLimits: reads.emilyLimits }, NOW), true);
  });

  it("keeps testnet unavailable", () => {
    assert.equal(
      evaluateGraniteCredit({
        intent: { ...borrowIntent, network: "testnet" },
        market,
        position,
        settlement: null,
        broadcastKnown: false,
        now: NOW,
      }).state,
      "unavailable",
    );
  });
});
