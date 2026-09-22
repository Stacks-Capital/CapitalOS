import test from "node:test";
import assert from "node:assert/strict";
import {
  attributeCashFlowYield,
  evaluateForward30dProjection,
  buildPerformanceChartSeries,
  underlyingFromShares,
  sharesFromUnderlying,
  type CashFlowEvent,
  type CanonicalObservation,
} from "./performance.ts";

test("Performance Attribution & Yield (I27)", async (t) => {
  await t.test("Acceptance Evidence 1: No balance increase is called yield without cash-flow attribution", () => {
    // Scenario 1: External balance increase without cash flows or share rate change
    // User deposited 1.0 sBTC (100,000,000 units), but ending balance is 1.5 sBTC (150,000,000 units).
    // Share rate remained 1:1.
    const depositEvent: CashFlowEvent = {
      id: "cf-1",
      kind: "deposit",
      assetId: "sbtc-token",
      amount: "100000000",
      timestamp: "2026-09-01T00:00:00Z",
    };

    const unverifiedResult = attributeCashFlowYield({
      assetId: "sbtc-token",
      currentUnderlyingValue: "150000000", // +50M balance increase
      currentShares: "100000000",
      currentShareRate: { numerator: "100000000", denominator: "100000000" }, // 1:1, no appreciation
      initialShareRate: { numerator: "100000000", denominator: "100000000" },
      cashFlows: [depositEvent],
    });

    // The 50,000,000 must NOT be called earned yield! It must be attributed as unattributed inflow!
    assert.equal(unverifiedResult.attribution.earnedYield, "0");
    assert.equal(unverifiedResult.attribution.unattributedInflow, "50000000");
    assert.equal(unverifiedResult.attribution.hasUnattributedInflow, true);
    assert.equal(unverifiedResult.attribution.costBasis, "100000000");
    assert.equal(unverifiedResult.attribution.netDeposits, "100000000");
    assert.ok(unverifiedResult.attribution.warnings.length > 0);
    assert.match(unverifiedResult.attribution.warnings[0]!, /unattributed inflow and excluded from earned yield/);

    // Scenario 2: Legitimate share-rate appreciation
    // User deposited 1.0 sBTC (100,000,000 shares at 1:1).
    // Later, share rate grew: 1 share is now worth 1.05 underlying assets (num: 100M, den: 105M).
    // Underlying worth = 100M * 105M / 100M = 105,000,000.
    const legitimateResult = attributeCashFlowYield({
      assetId: "sbtc-token",
      currentUnderlyingValue: "105000000",
      currentShares: "100000000",
      currentShareRate: { numerator: "100000000", denominator: "105000000" },
      initialShareRate: { numerator: "100000000", denominator: "100000000" },
      cashFlows: [depositEvent],
    });

    assert.equal(legitimateResult.attribution.earnedYield, "5000000");
    assert.equal(legitimateResult.attribution.unattributedInflow, "0");
    assert.equal(legitimateResult.attribution.hasUnattributedInflow, false);
    assert.equal(legitimateResult.accruedEstimate.shareAppreciationAmount, "5000000");
    assert.equal(legitimateResult.attribution.warnings.length, 0);

    // Scenario 3: Complex multi-action reconciliation (deposits, withdrawals, fees, claimed rewards)
    const complexCashFlows: CashFlowEvent[] = [
      { id: "cf-1", kind: "deposit", assetId: "sbtc-token", amount: "100000000", timestamp: "2026-08-01T00:00:00Z" },
      { id: "cf-2", kind: "withdrawal", assetId: "sbtc-token", amount: "40000000", timestamp: "2026-08-15T00:00:00Z" },
      { id: "cf-3", kind: "fee", assetId: "sbtc-token", amount: "50000", timestamp: "2026-08-15T00:00:00Z" },
      { id: "cf-4", kind: "reward_claim", assetId: "sbtc-token", amount: "200000", timestamp: "2026-08-20T00:00:00Z" },
    ];

    const complexResult = attributeCashFlowYield({
      assetId: "sbtc-token",
      currentUnderlyingValue: "65000000",
      currentShares: "60000000",
      currentShareRate: { numerator: "100000000", denominator: "105000000" }, // 5% appreciation on remaining 60M shares = 3M
      initialShareRate: { numerator: "100000000", denominator: "100000000" },
      cashFlows: complexCashFlows,
    });

    assert.equal(complexResult.attribution.depositsTotal, "100000000");
    assert.equal(complexResult.attribution.withdrawalsTotal, "40000000");
    assert.equal(complexResult.attribution.netDeposits, "60000000");
    assert.equal(complexResult.attribution.feesTotal, "50000");
    assert.equal(complexResult.attribution.claimedRewardsTotal, "200000");
    // Share appreciation on 60M shares = 3,000,000. Realized reward (200,000) - fee (50,000) = 150,000.
    // Total earned yield = 3,000,000 + 150,000 = 3,150,000.
    // Legitimate value = 60M net deposits + 3M share appreciation = 63,000,000.
    // Current value is 65,000,000, so 2,000,000 is unattributed inflow!
    assert.equal(complexResult.attribution.earnedYield, "3150000");
    assert.equal(complexResult.attribution.unattributedInflow, "2000000");
    assert.equal(complexResult.attribution.hasUnattributedInflow, true);
  });

  await t.test("Acceptance Evidence 2: Thirty-day projections require current verified rates", () => {
    // Case 1: Verified rate (e.g. 500 bps = 5.00% annual rate)
    const verified = evaluateForward30dProjection({
      principalAmount: "100000000", // 1 sBTC
      principalUsd: "6000000000", // $60,000.00
      rateBps: "500",
      rateStatus: "verified",
      rateDisagreement: "match",
      isStale: false,
    });

    assert.equal(verified.isProjectionAvailable, true);
    assert.equal(verified.rateStatus, "verified");
    assert.equal(verified.unavailableReason, null);
    // 100,000,000 * 500 * 30 / 3,650,000 = 410,958 units
    assert.equal(verified.projected30dAmount, "410958");
    // 6,000,000,000 * 500 * 30 / 3,650,000 = 24,657,534 ($246.57)
    assert.equal(verified.projected30dUsd, "24657534");

    // Case 2: Stale rate — MUST be null with reason (never 0 or guessed)
    const stale = evaluateForward30dProjection({
      principalAmount: "100000000",
      principalUsd: "6000000000",
      rateBps: "500",
      rateStatus: "stale",
      isStale: true,
    });

    assert.equal(stale.isProjectionAvailable, false);
    assert.equal(stale.projected30dAmount, null);
    assert.equal(stale.projected30dUsd, null);
    assert.equal(stale.rateStatus, "stale");
    assert.match(stale.unavailableReason!, /current rate is stale/);

    // Case 3: Disputed rate (reconciliation mismatch with independent node) — MUST be null with reason
    const disputed = evaluateForward30dProjection({
      principalAmount: "100000000",
      principalUsd: "6000000000",
      rateBps: "500",
      rateStatus: "disputed",
      rateDisagreement: "mismatch",
    });

    assert.equal(disputed.isProjectionAvailable, false);
    assert.equal(disputed.projected30dAmount, null);
    assert.equal(disputed.projected30dUsd, null);
    assert.equal(disputed.rateStatus, "disputed");
    assert.match(disputed.unavailableReason!, /rate is disputed/);

    // Case 4: Missing rate — MUST be null with reason
    const missing = evaluateForward30dProjection({
      principalAmount: "100000000",
      rateBps: null,
      rateStatus: "missing",
    });

    assert.equal(missing.isProjectionAvailable, false);
    assert.equal(missing.projected30dAmount, null);
    assert.equal(missing.projected30dUsd, null);
    assert.equal(missing.rateStatus, "missing");
    assert.match(missing.unavailableReason!, /market has no reported rate/);

    // Case 5: Unverified rate — MUST be null with reason
    const unverified = evaluateForward30dProjection({
      principalAmount: "100000000",
      rateBps: "450",
      rateStatus: "unverified",
    });

    assert.equal(unverified.isProjectionAvailable, false);
    assert.equal(unverified.projected30dAmount, null);
    assert.equal(unverified.projected30dUsd, null);
    assert.equal(unverified.rateStatus, "unverified");
    assert.match(unverified.unavailableReason!, /rate is unverified/);
  });

  await t.test(
    "Acceptance Evidence 3: History charts use two or more canonical observations and never synthetic points",
    () => {
      // Case 1: Less than 2 observations (0 or 1)
      const emptyObservations: CanonicalObservation[] = [];
      const chartZero = buildPerformanceChartSeries(emptyObservations, "100000000");

      assert.equal(chartZero.hasChart, false);
      assert.deepEqual(chartZero.points, []);
      assert.equal(chartZero.observationCount, 0);
      assert.match(chartZero.reason!, /require two or more canonical observations and never synthetic points/);

      const singleObservation: CanonicalObservation[] = [
        {
          observedAt: "2026-09-01T12:00:00Z",
          blockHeight: 180000,
          blockHash: "0xabc",
          source: "hiro-read",
          underlyingValue: "100000000",
        },
      ];
      const chartOne = buildPerformanceChartSeries(singleObservation, "100000000");

      assert.equal(chartOne.hasChart, false);
      assert.deepEqual(chartOne.points, []);
      assert.equal(chartOne.observationCount, 1);
      assert.match(chartOne.reason!, /require two or more canonical observations and never synthetic points/);

      // Case 2: Exactly 2 or more canonical observations — chart rendered without synthetic points
      const twoObservations: CanonicalObservation[] = [
        {
          observedAt: "2026-09-10T12:00:00Z", // later timestamp
          blockHeight: 181000,
          blockHash: "0xdef",
          source: "hiro-read",
          shareRate: { numerator: "100000000", denominator: "102000000" },
          positionShares: "100000000", // underlying = 102M
        },
        {
          observedAt: "2026-09-01T12:00:00Z", // earlier timestamp
          blockHeight: 180000,
          blockHash: "0xabc",
          source: "hiro-read",
          shareRate: { numerator: "100000000", denominator: "100000000" },
          positionShares: "100000000", // underlying = 100M
        },
      ];

      const chartTwo = buildPerformanceChartSeries(twoObservations, "100000000");

      assert.equal(chartTwo.hasChart, true);
      assert.equal(chartTwo.observationCount, 2);
      assert.equal(chartTwo.points.length, 2);
      assert.equal(chartTwo.reason, null);

      // Points must be sorted chronologically ascending
      assert.equal(chartTwo.points[0]!.timestamp, "2026-09-01T12:00:00Z");
      assert.equal(chartTwo.points[0]!.underlyingValue, "100000000");
      assert.equal(chartTwo.points[0]!.cumulativeYield, "0");
      assert.equal(chartTwo.points[0]!.blockHeight, 180000);

      assert.equal(chartTwo.points[1]!.timestamp, "2026-09-10T12:00:00Z");
      assert.equal(chartTwo.points[1]!.underlyingValue, "102000000");
      assert.equal(chartTwo.points[1]!.cumulativeYield, "2000000");
      assert.equal(chartTwo.points[1]!.blockHeight, 181000);
    },
  );

  await t.test("Share rate math conversions", () => {
    const rate = { numerator: "100000000", denominator: "110000000" }; // 1.1x
    // 100 shares at 1.1 = 110 assets
    assert.equal(underlyingFromShares("100000000", rate), "110000000");
    // 110 assets at 1.1 = 100 shares
    assert.equal(sharesFromUnderlying("110000000", rate), "100000000");
  });
});
