import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BPS,
  ORACLE_MAX_AGE_MS,
  computeHealth,
  marketsComparable,
  minOutFromSpot,
  projectedHealth,
  type OracleQuote,
} from "./risk.ts";

const now = new Date("2026-09-15T12:00:00.000Z");

function oracle(price: bigint, extras: Partial<OracleQuote> = {}): OracleQuote {
  return {
    price,
    scale: 8n,
    observedAt: now.toISOString(),
    source: "fixture",
    stale: false,
    maxAgeMs: ORACLE_MAX_AGE_MS,
    ...extras,
  };
}

const params = { ltvBorrowBps: 7000n, ltvLiqBps: 8000n, bufferBps: 500n };
const sbtc = { decimals: 8n, oracle: oracle(10_000_000_000_000n) };
const usdcx = { decimals: 6n, oracle: oracle(100_000_000n) };

describe("K14 risk arithmetic", () => {
  it("computes max borrow with bigint LTV and buffer, never JS numbers", () => {
    const health = computeHealth({
      collateral: { amount: 100_000_000n, ...sbtc },
      debt: { amount: 0n, ...usdcx },
      params,
      now,
    });
    assert.equal(health.stale, false);
    assert.equal(health.maxBorrow, 65_000_000_000n);
    assert.equal(health.healthy, true);
    assert.equal(health.withinBuffer, true);
  });

  it("treats 70% LTV as at-cap and 65% as inside the buffer", () => {
    const atCap = projectedHealth({
      collateralBefore: 100_000_000n,
      debtBefore: 0n,
      collateralDelta: 0n,
      debtDelta: 70_000_000_000n,
      collateral: sbtc,
      debt: usdcx,
      params,
      now,
    });
    assert.equal(atCap.currentLtvBps, 7000n);
    assert.equal(atCap.healthy, true);
    assert.equal(atCap.withinBuffer, false);

    const buffered = projectedHealth({
      collateralBefore: 100_000_000n,
      debtBefore: 0n,
      collateralDelta: 0n,
      debtDelta: 50_000_000_000n,
      collateral: sbtc,
      debt: usdcx,
      params,
      now,
    });
    assert.equal(buffered.withinBuffer, true);
    assert.equal(buffered.healthy, true);
  });

  it("fail-closes health when the oracle is older than 3 minutes", () => {
    const stale = computeHealth({
      collateral: { amount: 100_000_000n, decimals: 8n, oracle: oracle(10_000_000_000_000n, { observedAt: "2026-09-15T11:56:00.000Z" }) },
      debt: { amount: 1n, ...usdcx },
      params,
      now,
    });
    assert.equal(stale.stale, true);
    assert.equal(stale.maxBorrow, 0n);
    assert.equal(stale.healthy, false);
  });

  it("applies min-out slippage rounding down and refuses to compare Zest supply with Granite collateral", () => {
    assert.equal(minOutFromSpot(1000n, 50n), 995n);
    assert.equal(marketsComparable({ protocol: "zest", action: "supply" }, { protocol: "granite", action: "supply" }), false);
    assert.equal(marketsComparable({ protocol: "granite", action: "borrow" }, { protocol: "granite", action: "borrow" }), true);
    assert.equal(BPS, 10_000n);
  });
});
