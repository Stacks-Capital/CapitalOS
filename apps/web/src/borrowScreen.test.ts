import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketRisk } from "@stacks-capital/client";
import type { Health } from "@stacks-capital/core";
import {
  calculateBorrowAccounting,
  calculateDebtAccounting,
  calculateEasyRisk,
  isActionSafeToProceed,
} from "./borrowState.ts";

describe("Borrow, Repay, and Collateral Management Screen (I35)", () => {
  const sampleRisk: MarketRisk = {
    marketId: "granite.sbtc.isolated",
    params: {
      ltvBorrowBps: "7000", // 70.0% max borrow
      ltvLiqBps: "8000", // 80.0% liquidation threshold
      bufferBps: "500", // 5.0% buffer
      collateralDecimals: 8,
      debtDecimals: 6,
    },
    collateralOracle: {
      feedKey: "BTC/USD",
      price: "7000000000000", // $70,000
      scale: 8,
      publishedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      source: "pyth-oracle",
      stale: false,
      warnings: [],
    },
    debtOracle: {
      feedKey: "USDC/USD",
      price: "100000000", // $1.00
      scale: 8,
      publishedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      source: "pyth-oracle",
      stale: false,
      warnings: [],
    },
    position: {
      collateral: "100000000", // 1.0 sBTC ($70,000)
      debt: "20000000000", // 20,000 USDCx ($20,000)
      stale: false,
      warnings: [],
    },
    warnings: [],
  };

  const sampleHealth: Health = {
    collateralUsd: 7000000000000n, // $70,000
    debtUsd: 2000000000000n, // $20,000
    currentLtvBps: 2857n, // 28.57%
    healthFactorBps: 28000n, // 2.80x
    maxBorrow: 29000000000n, // $29,000 more borrowable
    liquidationThresholdBps: 8000n,
    withinBuffer: true,
    healthy: true,
    stale: false,
    warnings: [],
  };

  describe("Easy vs Advanced risk indicators", () => {
    it("computes liquidation price drop buffer and risk level accurately in Easy Mode", () => {
      const easy = calculateEasyRisk(sampleHealth, sampleRisk);
      assert.equal(easy.level, "safe");
      assert.equal(easy.levelLabel, "Safe Buffer");
      assert.equal(easy.badgeVariant, "badge-success");

      // Collateral = $70,000. Liq threshold at 80% = $56,000.
      // Debt = $20,000.
      // Drop % = (1 - 20000 / 56000) * 100 = (1 - 0.35714) * 100 = 64.3%
      assert.equal(easy.liquidationPriceDropPercent?.toFixed(1), "64.3");
      assert.ok(easy.explanation.includes("64.3%"));
      assert.ok(easy.maxSafeBorrowUsd! > 0);
    });

    it("flags danger when LTV breaches safe limits", () => {
      const dangerHealth: Health = {
        ...sampleHealth,
        currentLtvBps: 8200n, // above 80% liq threshold
        healthy: false,
        withinBuffer: false,
      };

      const easyDanger = calculateEasyRisk(dangerHealth, sampleRisk);
      assert.equal(easyDanger.level, "danger");
      assert.equal(easyDanger.badgeVariant, "badge-danger");
      assert.ok(easyDanger.explanation.includes("Immediate repayment"));
    });
  });

  describe("debt repayment accounting", () => {
    it("calculates partial repayment, remaining debt, and percentage paid", () => {
      const debtBefore = 20000000000n; // 20,000 USDCx
      const res = calculateDebtAccounting(debtBefore, "5000000000"); // Repay 5,000 USDCx

      assert.equal(res.currentDebt, 20000000000n);
      assert.equal(res.amountRepaid, 5000000000n);
      assert.equal(res.remainingDebt, 15000000000n);
      assert.equal(res.isFullRepay, false);
      assert.equal(res.debtReductionPercent, 25.0);
    });

    it("supports full repayment via 'max' keyword or exact debt amount", () => {
      const debtBefore = 20000000000n;
      const res = calculateDebtAccounting(debtBefore, "max");

      assert.equal(res.amountRepaid, 20000000000n);
      assert.equal(res.remainingDebt, 0n);
      assert.equal(res.isFullRepay, true);
      assert.equal(res.debtReductionPercent, 100.0);
    });
  });

  describe("borrow accounting", () => {
    it("calculates requested borrow, origination fees, net received, and new debt balance", () => {
      const debtBefore = 10000000000n; // 10,000 USDCx
      const res = calculateBorrowAccounting(debtBefore, "5000000000", 30); // Borrow 5,000 USDCx at 30 bps (0.3%)

      assert.equal(res.currentDebt, 10000000000n);
      assert.equal(res.requestedBorrow, 5000000000n);
      // Fee = 5,000 * 0.003 = 15 USDCx = 15000000
      assert.equal(res.estimatedFee, 15000000n);
      // Net = 5,000 - 15 = 4,985 USDCx = 4985000000
      assert.equal(res.netReceived, 4985000000n);
      // New total debt = 10,000 + 5,000 = 15,000 USDCx
      assert.equal(res.newTotalDebt, 15000000000n);
    });
  });

  describe("safety blocking and oracle gating", () => {
    it("blocks action when oracle is stale or has quorum disagreement", () => {
      const staleRisk: MarketRisk = {
        ...sampleRisk,
        collateralOracle: {
          ...sampleRisk.collateralOracle,
          stale: true,
        },
      };

      const checkStale = isActionSafeToProceed(null, staleRisk);
      assert.equal(checkStale.canProceed, false);
      assert.ok(checkStale.reason?.includes("stale"));

      const disputedRisk: MarketRisk = {
        ...sampleRisk,
        debtOracle: {
          ...sampleRisk.debtOracle,
          disagreement: true,
        },
      };

      const checkDispute = isActionSafeToProceed(null, disputedRisk);
      assert.equal(checkDispute.canProceed, false);
      assert.ok(checkDispute.reason?.includes("disagreement"));
    });

    it("blocks action when projection indicates safety policy breach", () => {
      const blockedProjection = {
        health: null,
        blockers: ["This would leave the position above the borrow limit."],
        notes: [],
        canProceed: false,
      };

      const checkBlocked = isActionSafeToProceed(blockedProjection, sampleRisk);
      assert.equal(checkBlocked.canProceed, false);
      assert.ok(checkBlocked.reason?.includes("borrow limit"));
    });
  });
});
