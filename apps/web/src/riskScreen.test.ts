import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_DELIVERY_LIMITATIONS,
  BTC_STRESS_COVERAGE_NOTE,
  DEFAULT_ALERT_SETTINGS,
  buildGraniteRiskAssessment,
  checkAlertTrigger,
  loadAlertSettings,
  saveAlertSettings,
} from "./riskState.ts";
import { RISK_CALCULATION_VERSION } from "@stacks-capital/core";
import type { MarketRisk } from "@stacks-capital/client";

describe("Risk & Alerts State (I38)", () => {
  const freshObservedAt = new Date().toISOString();

  const mockFreshMarketRisk: MarketRisk = {
    marketId: "granite.sbtc.isolated",
    params: {
      ltvBorrowBps: "7500",
      ltvLiqBps: "8000",
      bufferBps: "500",
      collateralDecimals: 8,
      debtDecimals: 6,
    },
    collateralOracle: {
      feedKey: "pyth.sbtc",
      price: "10000000000000", // $100,000 with scale 8
      scale: 8,
      observedAt: freshObservedAt,
      publishedAt: freshObservedAt,
      source: "Pyth Hermes sBTC/USD",
      stale: false,
      warnings: [],
      status: "verified",
    },
    debtOracle: {
      feedKey: "redstone.usdcx",
      price: "100000000", // $1.00 with scale 8
      scale: 8,
      observedAt: freshObservedAt,
      publishedAt: freshObservedAt,
      source: "Redstone USDCx/USD",
      stale: false,
      warnings: [],
      status: "verified",
    },
    position: {
      collateral: "100000000", // 1.0 sBTC = $100,000
      debt: "50000000000", // 50,000 USDCx = $50,000 (50% LTV)
      stale: false,
      warnings: [],
    },
    warnings: [],
  };

  describe("Acceptance Evidence 1: Risk numbers expose meaning, source, timestamp and calculation version", () => {
    it("exposes meaning, source, timestamp and calculationVersion for all risk metrics", () => {
      const assessment = buildGraniteRiskAssessment(mockFreshMarketRisk, new Date());
      assert.notEqual(assessment.health, null);
      assert.equal(assessment.metrics.length > 0, true);

      for (const metric of assessment.metrics) {
        assert.ok(metric.meaning, `Metric ${metric.id} must have a non-empty meaning`);
        assert.ok(metric.source, `Metric ${metric.id} must disclose its oracle or contract source`);
        assert.ok(metric.timestamp, `Metric ${metric.id} must have an observed timestamp`);
        assert.equal(
          metric.calculationVersion,
          RISK_CALCULATION_VERSION,
          `Metric ${metric.id} must have calculationVersion ${RISK_CALCULATION_VERSION}`,
        );
      }
    });

    it("evaluates health factor and LTV accurately for a 50% LTV position", () => {
      const assessment = buildGraniteRiskAssessment(mockFreshMarketRisk, new Date());
      const hfMetric = assessment.metrics.find((m) => m.id === "health_factor");
      const ltvMetric = assessment.metrics.find((m) => m.id === "current_ltv");

      assert.ok(hfMetric);
      assert.ok(ltvMetric);
      // Collateral: $100,000. Liq threshold: 80%. Liq value: $80,000. Debt: $50,000. HF = 80000/50000 = 1.6
      assert.equal(hfMetric.displayValue, "1.60");
      assert.equal(ltvMetric.displayValue, "50.00%");
      assert.equal(hfMetric.status, "fresh");
    });

    it("fails closed on stale or disputed oracles", () => {
      const staleRisk: MarketRisk = {
        ...mockFreshMarketRisk,
        collateralOracle: {
          ...mockFreshMarketRisk.collateralOracle,
          stale: true,
          status: "stale",
        },
      };

      const assessment = buildGraniteRiskAssessment(staleRisk, new Date());
      assert.ok(assessment.health);
      assert.equal(assessment.health.stale, true);

      const hfMetric = assessment.metrics.find((m) => m.id === "health_factor");
      assert.ok(hfMetric);
      assert.equal(hfMetric.status, "stale");
      assert.match(hfMetric.displayValue, /Unavailable/);
    });

    it("safely handles zero-debt positions with sentinel HF 10.0", () => {
      const zeroDebtRisk: MarketRisk = {
        ...mockFreshMarketRisk,
        position: {
          collateral: "100000000",
          debt: "0",
          stale: false,
          warnings: [],
        },
      };

      const assessment = buildGraniteRiskAssessment(zeroDebtRisk, new Date());
      assert.ok(assessment.health);
      const hfMetric = assessment.metrics.find((m) => m.id === "health_factor");
      assert.ok(hfMetric);
      assert.match(hfMetric.displayValue, /10\.0/);
    });
  });

  describe("Acceptance Evidence 2: BTC stress scenarios state assumptions and coverage", () => {
    it("discloses stress scenario assumptions and single-asset coverage", () => {
      const assessment = buildGraniteRiskAssessment(mockFreshMarketRisk, new Date());
      assert.ok(assessment.scenarios);

      // Assumptions
      assert.ok(assessment.scenarios.assumptions.note);
      assert.match(assessment.scenarios.assumptions.note, /Only the collateral price moves/);
      assert.equal(assessment.scenarios.assumptions.collateralFeed, "Pyth Hermes sBTC/USD");
      assert.equal(assessment.scenarios.assumptions.debtFeed, "Redstone USDCx/USD");
      assert.equal(assessment.scenarios.assumptions.liquidationThresholdBps, "8000");

      // Coverage note
      assert.match(BTC_STRESS_COVERAGE_NOTE, /Granite isolated sBTC \/ USDCx/);
      assert.match(
        BTC_STRESS_COVERAGE_NOTE,
        /Debt, accrued interest, and protocol liquidation thresholds are held constant/,
      );

      // Standard shifts: -5%, -10%, -20%, -30%, -50%
      assert.equal(assessment.scenarios.rows.length, 5);
      const rowMinus50 = assessment.scenarios.rows.find((r) => r.shiftBps === -5000);
      assert.ok(rowMinus50);
      assert.ok(rowMinus50.health);
      // At -50% price ($50,000 sBTC), collateral = $50,000, debt = $50,000 -> LTV = 100% >= 80% liquidation threshold
      assert.equal(rowMinus50.health.currentLtvBps, 10000n);
      assert.equal(rowMinus50.health.healthy, false);
    });

    it("withholds stress calculations when oracle is stale", () => {
      const staleRisk: MarketRisk = {
        ...mockFreshMarketRisk,
        collateralOracle: {
          ...mockFreshMarketRisk.collateralOracle,
          stale: true,
        },
      };

      const assessment = buildGraniteRiskAssessment(staleRisk, new Date());
      assert.ok(assessment.scenarios);
      for (const row of assessment.scenarios.rows) {
        assert.equal(row.health, null);
        assert.match(row.unavailableReason ?? "", /stale/i);
      }
    });
  });

  describe("Acceptance Evidence 3: Alerts disclose delivery limitations and consent", () => {
    it("requires explicit user consent and acknowledgement of delivery limitations", () => {
      assert.equal(DEFAULT_ALERT_SETTINGS.enabled, false);
      assert.equal(DEFAULT_ALERT_SETTINGS.limitationsAcknowledged, false);
      assert.equal(DEFAULT_ALERT_SETTINGS.consentedAt, null);

      // Verify all mandatory limitation disclosures are present
      assert.equal(ALERT_DELIVERY_LIMITATIONS.length >= 4, true);
      const joined = ALERT_DELIVERY_LIMITATIONS.join(" ");
      assert.match(joined, /Client-Side Only/i);
      assert.match(joined, /Advisory Invariant/i);
      assert.match(joined, /Explicit User Consent/i);
    });

    it("does not trigger alerts without opt-in consent and limitation acknowledgement", () => {
      const assessment = buildGraniteRiskAssessment(mockFreshMarketRisk, new Date());
      // Un-consented settings
      const unconsented = { ...DEFAULT_ALERT_SETTINGS };
      const outcome = checkAlertTrigger(assessment.health, unconsented);
      assert.equal(outcome.triggered, false);
    });

    it("triggers alert when consented and health factor drops below user threshold", () => {
      const assessment = buildGraniteRiskAssessment(mockFreshMarketRisk, new Date());
      // Consented settings with threshold 1.80 (current HF is 1.60)
      const consented = {
        enabled: true,
        minHealthFactor: 1.8,
        staleOracleWarning: true,
        consentedAt: new Date().toISOString(),
        limitationsAcknowledged: true,
      };

      const outcome = checkAlertTrigger(assessment.health, consented);
      assert.equal(outcome.triggered, true);
      assert.match(outcome.message ?? "", /below your safety threshold of 1\.80/);
    });

    it("persists and reloads alert settings through local storage mock", () => {
      const store: Record<string, string> = {};
      const mockStorage = {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      };

      const settings = {
        enabled: true,
        minHealthFactor: 1.5,
        staleOracleWarning: true,
        consentedAt: "2026-09-22T12:00:00Z",
        limitationsAcknowledged: true,
      };

      saveAlertSettings(settings, mockStorage);
      const loaded = loadAlertSettings(mockStorage);
      assert.deepEqual(loaded, settings);
    });
  });
});
