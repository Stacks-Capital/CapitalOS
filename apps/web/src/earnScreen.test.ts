import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EarnOption } from "@stacks-capital/client";
import {
  calculateStrategyReturns,
  canSupplyOption,
  canWithdrawOption,
  filterEarnOptions,
  formatEvidenceBadge,
} from "./earnState.ts";

describe("Earn Marketplace and Strategy Simulation Screen (I34)", () => {
  const sampleOptions: EarnOption[] = [
    {
      marketId: "zest.sbtc.v2",
      protocol: "Zest Protocol",
      suppliedAssetId: "sBTC",
      receiptAssetId: "zsBTC",
      supply: { state: "enabled", reason: "Active vault supply" },
      withdrawal: { state: "enabled", reason: "Liquid 1:1 redemption" },
      baseRate: "450", // 4.5%
      baseRateScale: 4,
      incentiveRate: "150", // 1.5%
      incentiveRateScale: 4,
      availableLiquidity: "250.50 sBTC",
      capacity: "1000.00 sBTC",
      paused: false,
      stale: false,
      warnings: [],
      observedAt: "2026-09-22T09:58:00.000Z",
      adapterVersion: "2.0.0",
      evidence: {
        confidence: "high",
        source: "hiro-rpc-node-verified",
        disagreement: "match",
        isIndependentRead: true,
        ageSeconds: 120,
        blockHeight: 885000,
        blockHash: "0x123",
      },
    },
    {
      marketId: "granite.sbtc.yield",
      protocol: "Granite",
      suppliedAssetId: "sBTC",
      receiptAssetId: null,
      supply: { state: "enabled", reason: "Active pool" },
      withdrawal: { state: "disabled", reason: "Emergency lockup active" },
      baseRate: "380", // 3.8%
      baseRateScale: 4,
      incentiveRate: null,
      incentiveRateScale: null,
      availableLiquidity: "120.00 sBTC",
      capacity: "500.00 sBTC",
      paused: false,
      stale: false,
      warnings: [],
      observedAt: "2026-09-22T09:59:00.000Z",
      adapterVersion: "2.0.0",
      evidence: {
        confidence: "medium",
        source: "hiro-rpc-node-verified",
        disagreement: "match",
        isIndependentRead: true,
        ageSeconds: 60,
        blockHeight: 885000,
        blockHash: "0x456",
      },
    },
    {
      marketId: "unverified.sbtc.vault",
      protocol: "Experimental",
      suppliedAssetId: "sBTC",
      receiptAssetId: null,
      supply: { state: "enabled", reason: "Beta vault" },
      withdrawal: { state: "enabled", reason: "Beta" },
      baseRate: "800",
      baseRateScale: 4,
      incentiveRate: null,
      incentiveRateScale: null,
      availableLiquidity: "10.00 sBTC",
      capacity: "100.00 sBTC",
      paused: false,
      stale: false,
      warnings: ["Provider reported rate lacks independent verification"],
      observedAt: "2026-09-22T09:59:00.000Z",
      adapterVersion: "2.0.0",
      evidence: {
        confidence: "low",
        source: "provider-self-reported",
        disagreement: "mismatch",
        isIndependentRead: false,
        ageSeconds: 60,
        blockHeight: 885000,
        blockHash: null,
      },
    },
    {
      marketId: "stale.stx.vault",
      protocol: "Old Protocol",
      suppliedAssetId: "STX",
      receiptAssetId: null,
      supply: { state: "disabled", reason: "Pool paused" },
      withdrawal: { state: "enabled", reason: "Active" },
      baseRate: "500",
      baseRateScale: 4,
      incentiveRate: null,
      incentiveRateScale: null,
      availableLiquidity: "50.00 STX",
      capacity: "200.00 STX",
      paused: true,
      stale: true,
      warnings: ["Reading is older than 5 minutes"],
      observedAt: "2026-09-22T09:40:00.000Z",
      adapterVersion: "2.0.0",
    },
  ];

  describe("same-asset filtering and evidence presentation", () => {
    it("filters earn opportunities by supplied asset correctly", () => {
      const sbtcOptions = filterEarnOptions(sampleOptions, "sBTC");
      assert.equal(sbtcOptions.length, 3);
      assert.ok(sbtcOptions.every((o) => o.suppliedAssetId === "sBTC"));

      const stxOptions = filterEarnOptions(sampleOptions, "STX");
      assert.equal(stxOptions.length, 1);
      assert.equal(stxOptions[0]?.marketId, "stale.stx.vault");

      const allOptions = filterEarnOptions(sampleOptions, "all");
      assert.equal(allOptions.length, 4);
    });

    it("formats evidence badges and detects onchain mismatches", () => {
      const verifiedBadge = formatEvidenceBadge(sampleOptions[0]!);
      assert.equal(verifiedBadge.label, "Verified Onchain");
      assert.equal(verifiedBadge.variant, "badge-success");
      assert.equal(verifiedBadge.isMismatch, false);

      const mismatchBadge = formatEvidenceBadge(sampleOptions[2]!);
      assert.equal(mismatchBadge.label, "Low Confidence");
      assert.equal(mismatchBadge.isMismatch, true);

      const staleBadge = formatEvidenceBadge(sampleOptions[3]!);
      assert.equal(staleBadge.label, "Stale Reading");
      assert.equal(staleBadge.variant, "badge-danger");
    });

    it("enforces capability gating for supply and withdrawal actions", () => {
      // Zest allows both supply and withdrawal
      assert.equal(canSupplyOption(sampleOptions[0]), true);
      assert.equal(canWithdrawOption(sampleOptions[0]), true);

      // Granite has withdrawal locked
      assert.equal(canSupplyOption(sampleOptions[1]), true);
      assert.equal(canWithdrawOption(sampleOptions[1]), false);

      // Stale STX vault is paused
      assert.equal(canSupplyOption(sampleOptions[3]), false);
      assert.equal(canWithdrawOption(sampleOptions[3]), false);
    });
  });

  describe("strategy simulation mathematics and disclosures", () => {
    it("calculates exact projected returns without hidden multipliers", () => {
      // 10 sBTC at 450 bps (4.5%) base + 150 bps (1.5%) incentive over 365 days
      const res365 = calculateStrategyReturns("10.00", 450, 150, 365);
      assert.equal(res365.principalAmount, 10);
      assert.equal(res365.effectiveApyPercent, 6.0);
      assert.equal(res365.baseYieldAmount.toFixed(4), "0.4500");
      assert.equal(res365.incentiveYieldAmount.toFixed(4), "0.1500");
      assert.equal(res365.totalYieldAmount.toFixed(4), "0.6000");
      assert.equal(res365.projectedEndingBalance.toFixed(4), "10.6000");

      // 180-day projection: 10 * 0.06 * (180/365) = 0.29589
      const res180 = calculateStrategyReturns("10.00", 450, 150, 180);
      assert.equal(res180.totalYieldAmount.toFixed(4), "0.2959");
      assert.equal(res180.projectedEndingBalance.toFixed(4), "10.2959");
    });

    it("handles zero or empty principal gracefully", () => {
      const resZero = calculateStrategyReturns("0.00", 500, 0, 90);
      assert.equal(resZero.principalAmount, 0);
      assert.equal(resZero.totalYieldAmount, 0);
      assert.equal(resZero.projectedEndingBalance, 0);
    });
  });
});
