import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateEarn } from "./simulation.ts";

describe("Earn strategy simulation (I34)", () => {
  it("computes projected yields accurately from exact disclosed inputs", () => {
    // 10 sBTC at 4.5% base APY (scale 4 => value 450) and 1.5% incentive APY (scale 4 => value 150) for 365 days
    const result = simulateEarn({
      principal: "10",
      baseRate: { value: "450", scale: 4 }, // 0.0450
      incentiveRate: { value: "150", scale: 4 }, // 0.0150
      horizonDays: 365,
    });

    assert.equal(result.principalAmount, 10);
    assert.equal(result.horizonDays, 365);
    assert.equal(result.baseApyPercent.toFixed(2), "4.50");
    assert.equal(result.incentiveApyPercent.toFixed(2), "1.50");
    assert.equal(result.effectiveApyPercent.toFixed(2), "6.00");
    assert.equal(result.baseYieldAmount.toFixed(4), "0.4500");
    assert.equal(result.incentiveYieldAmount.toFixed(4), "0.1500");
    assert.equal(result.totalYieldAmount.toFixed(4), "0.6000");
    assert.equal(result.projectedEndingBalance.toFixed(4), "10.6000");
    assert.equal(result.isReliable, true);
    assert.equal(result.warnings.length, 0);
  });

  it("calculates partial year horizon correctly (e.g. 30 days and 90 days)", () => {
    const res30 = simulateEarn({
      principal: "10000",
      baseRate: { value: "730", scale: 4 }, // 7.30%
      incentiveRate: null,
      horizonDays: 30,
    });

    // 10000 * 0.073 * (30 / 365) = 10000 * 0.073 * 0.08219178 = 60.0
    assert.equal(res30.baseYieldAmount.toFixed(2), "60.00");
    assert.equal(res30.incentiveYieldAmount, 0);
    assert.equal(res30.totalYieldAmount.toFixed(2), "60.00");
    assert.equal(res30.projectedEndingBalance.toFixed(2), "10060.00");
  });

  it("flags stale reading, low evidence confidence, or mismatch as unreliable", () => {
    const staleResult = simulateEarn({
      principal: "5",
      baseRate: { value: "500", scale: 4 },
      incentiveRate: null,
      horizonDays: 90,
      isStale: true,
      confidence: "low",
      disagreement: "mismatch",
    });

    assert.equal(staleResult.isReliable, false);
    assert.ok(staleResult.warnings.some((w) => w.includes("stale")));
    assert.ok(staleResult.warnings.some((w) => w.includes("confidence")));
    assert.ok(staleResult.warnings.some((w) => w.includes("disagree")));
  });

  it("handles zero or invalid principal safely", () => {
    const zeroResult = simulateEarn({
      principal: "0",
      baseRate: { value: "500", scale: 4 },
      incentiveRate: null,
      horizonDays: 30,
    });

    assert.equal(zeroResult.principalAmount, 0);
    assert.equal(zeroResult.totalYieldAmount, 0);
    assert.equal(zeroResult.isReliable, false);
    assert.ok(zeroResult.warnings.some((w) => w.includes("greater than zero")));
  });
});
