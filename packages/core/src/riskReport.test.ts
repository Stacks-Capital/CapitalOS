import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORACLE_MAX_AGE_MS, computeHealth, type OracleQuote } from "./risk.ts";
import {
  RISK_CALCULATION_VERSION,
  borrowLiquidityGate,
  concentrationByQuantity,
  graniteProtectiveActions,
  interpretGraniteHealth,
  shiftOraclePrice,
  stressGraniteCollateral,
  unsupportedCreditRisk,
  wouldLiquidateAtLtv,
} from "./riskReport.ts";

const now = new Date("2026-09-15T12:00:00.000Z");
const params = { ltvBorrowBps: 7000n, ltvLiqBps: 8000n, bufferBps: 500n };

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

const sbtcSide = { amount: 100_000_000n, decimals: 8n, oracle: oracle(10_000_000_000_000n) };
const usdcxSide = { amount: 0n, decimals: 6n, oracle: oracle(100_000_000n) };

describe("K36 Granite health interpretation", () => {
  it("treats HF 1.0 as the liquidation threshold and documents protocol meaning", () => {
    const atLiq = computeHealth({
      collateral: sbtcSide,
      debt: { ...usdcxSide, amount: 80_000_000_000n },
      params,
      now,
    });
    assert.equal(atLiq.currentLtvBps, 8000n);
    assert.equal(atLiq.healthFactorBps, 10_000n);
    const interpreted = interpretGraniteHealth(atLiq, params);
    assert.equal(interpreted.calculationVersion, RISK_CALCULATION_VERSION);
    assert.equal(interpreted.protocol, "granite");
    assert.equal(interpreted.liquidatable, true);
    assert.equal(interpreted.healthy, false);
    assert.equal(wouldLiquidateAtLtv(atLiq.currentLtvBps, params.ltvLiqBps), true);
    assert.match(interpreted.meaning, /liquidation threshold/);
    assert.ok(interpreted.limitations.length >= 3);
    assert.equal(interpreted.inputs.debtUsd > 0n, true);
  });

  it("keeps borrow-cap health distinct from the advisory buffer", () => {
    const atBorrowCap = computeHealth({
      collateral: sbtcSide,
      debt: { ...usdcxSide, amount: 70_000_000_000n },
      params,
      now,
    });
    const interpreted = interpretGraniteHealth(atBorrowCap, params);
    assert.equal(interpreted.withinBorrowCap, true);
    assert.equal(interpreted.withinBuffer, false);
    assert.equal(interpreted.liquidatable, false);
    assert.equal(interpreted.healthy, true);
  });

  it("fail-closes interpretation when the oracle is stale instead of inventing safety", () => {
    const stale = computeHealth({
      collateral: {
        ...sbtcSide,
        oracle: oracle(10_000_000_000_000n, { observedAt: "2026-09-15T11:56:00.000Z" }),
      },
      debt: { ...usdcxSide, amount: 1n },
      params,
      now,
    });
    const interpreted = interpretGraniteHealth(stale, params);
    assert.equal(interpreted.stale, true);
    assert.equal(interpreted.liquidatable, false);
    assert.equal(interpreted.healthy, false);
    assert.match(interpreted.meaning, /unavailable/);
  });
});

describe("K36 stress scenarios and protective actions", () => {
  it("never invents a base price or unsupported non-positive shift", () => {
    assert.equal(shiftOraclePrice(0n, -1000), null);
    assert.equal(shiftOraclePrice(100n, -10_000), null);
    assert.equal(shiftOraclePrice(100_000n, -1000), 90_000n);

    const report = stressGraniteCollateral({
      collateral: sbtcSide,
      debt: { ...usdcxSide, amount: 50_000_000_000n },
      params,
      now,
      collateralFeed: "BTC/USD",
      debtFeed: "USDC/USD",
      shiftsBps: [-1000, -10_000],
    });
    assert.equal(report.calculationVersion, RISK_CALCULATION_VERSION);
    assert.equal(report.rows[0]?.health?.stale, false);
    assert.equal(report.rows[1]?.health, null);
    assert.match(report.rows[1]?.unavailableReason ?? "", /non-positive/);
    assert.ok(report.limitations.some((line) => /held still/i.test(line)));
  });

  it("withholds every scenario when an oracle is stale", () => {
    const report = stressGraniteCollateral({
      collateral: {
        ...sbtcSide,
        oracle: oracle(10_000_000_000_000n, { observedAt: "2026-09-15T11:50:00.000Z" }),
      },
      debt: usdcxSide,
      params,
      now,
      collateralFeed: "BTC/USD",
      debtFeed: "USDC/USD",
      shiftsBps: [-1000, -2000],
    });
    assert.ok(report.rows.every((row) => row.health === null && row.unavailableReason !== null));
  });

  it("blocks borrow when health, pause or liquidity evidence fails", () => {
    const healthy = computeHealth({
      collateral: sbtcSide,
      debt: usdcxSide,
      params,
      now,
    });
    const ok = graniteProtectiveActions({
      health: healthy,
      vaultPaused: false,
      liquidityAvailable: 100_000_000_000n,
      requestedBorrow: 10_000_000_000n,
    });
    assert.equal(ok.actions.find((a) => a.action === "borrow")?.allowed, true);
    assert.equal(ok.actions.find((a) => a.action === "repay")?.allowed, true);

    const blocked = graniteProtectiveActions({
      health: healthy,
      vaultPaused: true,
      liquidityAvailable: null,
      requestedBorrow: 1n,
    });
    assert.equal(blocked.actions.find((a) => a.action === "borrow")?.allowed, false);

    const liq = borrowLiquidityGate(null, 1n);
    assert.equal(liq.sufficient, null);
    assert.match(liq.reason, /unknown/);
    assert.equal(borrowLiquidityGate(5n, 6n).sufficient, false);
  });

  it("refuses credit health for earn and swap protocols", () => {
    const zest = unsupportedCreditRisk("zest", "Zest earn has no liquidation health factor.");
    assert.equal(zest.kind, "unavailable");
    assert.equal(zest.calculationVersion, RISK_CALCULATION_VERSION);
    assert.match(zest.reason, /Zest/);
  });
});

describe("K36 concentration", () => {
  it("computes same-asset shares and fail-closes on mixed or unknown quantities", () => {
    const ok = concentrationByQuantity([
      { key: "granite", quantity: 60n, assetId: "sbtc" },
      { key: "zest", quantity: 40n, assetId: "sbtc" },
    ]);
    assert.equal(ok.available, true);
    assert.equal(ok.total, 100n);
    assert.equal(ok.slices[0]?.shareBps, 6000n);

    const mixed = concentrationByQuantity([
      { key: "a", quantity: 1n, assetId: "sbtc" },
      { key: "b", quantity: 1n, assetId: "usdcx" },
    ]);
    assert.equal(mixed.available, false);
    assert.match(mixed.reason ?? "", /different assets/);

    const unknown = concentrationByQuantity([{ key: "m", quantity: null, assetId: "sbtc" }]);
    assert.equal(unknown.available, false);
    assert.match(unknown.reason ?? "", /unknown/);
  });
});
