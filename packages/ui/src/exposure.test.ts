import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketRisk, Position } from "@stacks-capital/client";
import { concentrationBy, DEFAULT_SHIFTS, scenarios, wouldLiquidate } from "./exposure.ts";

const SBTC = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
const USDCX = "stacks:mainnet:contract:SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token:usdcx-token";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const FRESH = "2026-09-18T11:59:00.000Z";

function position(overrides: Partial<Position> = {}): Position {
  return {
    marketId: "zest.sbtc.vault",
    kind: "supplied",
    protocolKey: "zest.sbtc.vault:supplied",
    assetId: SBTC,
    quantity: "100000000",
    stale: false,
    warnings: [],
    observedAt: FRESH,
    blockHeight: 9012515,
    rewardRate: null,
    rewardScale: null,
    adapterVersion: "zest-earn@0.1.0",
    calculationVersion: "position-decoder@0.1.0",
    ...overrides,
  };
}

function risk(overrides: Partial<MarketRisk> = {}): MarketRisk {
  return {
    marketId: "granite.sbtc.isolated",
    params: { ltvBorrowBps: "7000", ltvLiqBps: "8000", bufferBps: "500", collateralDecimals: 8, debtDecimals: 6 },
    collateralOracle: {
      feedKey: "BTC/USD",
      price: "7000000000000",
      scale: 8,
      publishedAt: FRESH,
      observedAt: FRESH,
      source: "dia-oracle",
      stale: false,
      warnings: [],
    },
    debtOracle: {
      feedKey: "USDC/USD",
      price: "100000000",
      scale: 8,
      publishedAt: FRESH,
      observedAt: FRESH,
      source: "dia-oracle",
      stale: false,
      warnings: [],
    },
    // 1 sBTC collateral (70,000 USD) against 35,000 USDC of debt: 50% LTV.
    position: { collateral: "100000000", debt: "35000000000", stale: false, warnings: [] },
    warnings: [],
    ...overrides,
  };
}

const marketOf = (entry: Position) => entry.marketId;

describe("concentration", () => {
  it("shows the share each market holds", () => {
    const result = concentrationBy(
      [
        position({ marketId: "zest.sbtc.vault", quantity: "75000000" }),
        position({ marketId: "granite.sbtc.isolated", kind: "collateral", quantity: "25000000" }),
      ],
      marketOf,
    );
    assert.equal(result.available, true);
    assert.equal(result.available && result.value.total, "100000000");
    assert.deepEqual(result.available ? result.value.slices.map((slice) => [slice.key, slice.shareBps]) : [], [
      ["zest.sbtc.vault", "7500"],
      ["granite.sbtc.isolated", "2500"],
    ]);
  });

  it("is unavailable when any position is unknown, rather than counting it as nothing", () => {
    const result = concentrationBy(
      [position({ quantity: "75000000" }), position({ marketId: "granite.sbtc.isolated", quantity: null })],
      marketOf,
    );
    assert.equal(result.available, false);
    assert.match(result.available === false ? result.reason : "", /granite.sbtc.isolated.*cannot be worked out/);
  });

  it("refuses to add positions held in different assets", () => {
    const result = concentrationBy([position(), position({ marketId: "other", assetId: USDCX })], marketOf);
    assert.equal(result.available, false);
    assert.match(result.available === false ? result.reason : "", /different assets/);
  });

  it("says when there is nothing to compare", () => {
    assert.equal(concentrationBy([], marketOf).available, false);
    const empty = concentrationBy([position({ quantity: "0" })], marketOf);
    assert.match(empty.available === false ? empty.reason : "", /nothing to compare/);
  });

  it("ignores kinds that are not exposure, like debt", () => {
    const result = concentrationBy(
      [position(), position({ marketId: "granite", kind: "debt", quantity: "999" })],
      marketOf,
    );
    assert.equal(result.available && result.value.slices.length, 1);
  });
});

describe("scenarios", () => {
  it("shows what a price fall would do, with the assumptions beside it", () => {
    const { assumptions, rows } = scenarios(risk(), NOW);
    assert.equal(assumptions.collateralFeed, "BTC/USD");
    assert.equal(assumptions.collateralPrice, "7000000000000");
    assert.equal(assumptions.liquidationThresholdBps, "8000");
    assert.match(assumptions.note, /Only the collateral price moves/);

    assert.deepEqual(
      rows.map((row) => row.label),
      ["-10%", "-20%", "-30%", "-50%"],
    );
    const fall20 = rows[1];
    assert.equal(fall20?.health.available, true);
    // 50% LTV becomes 62.5% when the collateral is worth 20% less.
    assert.equal(fall20?.health.available === true ? fall20.health.value.currentLtvBps : 0n, 6250n);
  });

  it("marks the scenarios that would liquidate", () => {
    const { assumptions, rows } = scenarios(risk(), NOW);
    const liquidating = rows.filter((row) => wouldLiquidate(row, assumptions.liquidationThresholdBps));
    // A 30% fall takes a 50% LTV position to about 71%, still under the 80% threshold. A 50% fall reaches 100%.
    assert.deepEqual(
      liquidating.map((row) => row.label),
      ["-50%"],
    );
    const fall30 = rows[2];
    assert.equal(fall30?.health.available === true ? fall30.health.value.currentLtvBps : 0n, 7143n);
  });

  it("labels every scenario unavailable when an input is missing, with the reason", () => {
    const cases: [Partial<MarketRisk>, RegExp][] = [
      [{ params: null }, /risk parameters could not be read/],
      [{ position: { collateral: null, debt: null, stale: true, warnings: [] } }, /position in this market is unknown/],
      [{ collateralOracle: { ...risk().collateralOracle, price: null } }, /No price for BTC\/USD/],
      [
        { collateralOracle: { ...risk().collateralOracle, publishedAt: "2026-09-18T11:00:00.000Z" } },
        /BTC\/USD price is stale/,
      ],
      [{ debtOracle: { ...risk().debtOracle, price: null } }, /No price for USDC\/USD/],
    ];

    for (const [overrides, reason] of cases) {
      const { rows } = scenarios(risk(overrides), NOW);
      assert.equal(rows.length, DEFAULT_SHIFTS.length);
      assert.ok(
        rows.every((row) => !row.health.available),
        JSON.stringify(overrides),
      );
      const first = rows[0];
      assert.match(first?.health.available === false ? first.health.reason : "", reason);
    }
  });

  it("takes the price moves it is given", () => {
    const { rows } = scenarios(risk(), NOW, [-500, 1000]);
    assert.deepEqual(
      rows.map((row) => row.label),
      ["-5%", "+10%"],
    );
    // A rise leaves the position healthier than it is now.
    const rise = rows[1];
    assert.ok(rise?.health.available === true && rise.health.value.currentLtvBps < 5000n);
  });

  it("does not claim a liquidation when the scenario could not be worked out", () => {
    const { assumptions, rows } = scenarios(risk({ params: null }), NOW);
    assert.equal(
      rows.every((row) => !wouldLiquidate(row, assumptions.liquidationThresholdBps)),
      true,
    );
  });
});
