import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EarnOption } from "@stacks-capital/client";
import { addRates, compareEarn, compareRates, formatRate } from "./compare.ts";

const SBTC = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
const USDCX = "stacks:mainnet:contract:SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token:usdcx-token";
const NOW = new Date("2026-09-18T12:00:00.000Z");

function option(overrides: Partial<EarnOption> = {}): EarnOption {
  return {
    marketId: "zest.sbtc.vault",
    protocol: "zest",
    suppliedAssetId: SBTC,
    receiptAssetId: null,
    supply: { state: "enabled", reason: "live" },
    withdrawal: { state: "enabled", reason: "live" },
    baseRate: "130",
    baseRateScale: 4,
    incentiveRate: null,
    incentiveRateScale: null,
    availableLiquidity: "58693265572",
    capacity: "500000000000",
    paused: false,
    stale: false,
    warnings: [],
    observedAt: "2026-09-18T11:58:00.000Z",
    adapterVersion: "zest-earn@0.1.0",
    ...overrides,
  };
}

const rowFor = (comparison: ReturnType<typeof compareEarn>, marketId: string) =>
  comparison.groups.flatMap((group) => group.rows).find((row) => row.option.marketId === marketId);

describe("rates", () => {
  it("add across different scales and keep the finer one", () => {
    assert.deepEqual(addRates({ value: "130", scale: 4 }, { value: "50", scale: 4 }), { value: "180", scale: 4 });
    assert.deepEqual(addRates({ value: "130", scale: 4 }, { value: "5", scale: 2 }), { value: "630", scale: 4 });
    assert.deepEqual(addRates({ value: "130", scale: 4 }, null), { value: "130", scale: 4 });
  });

  it("compare across scales, and refuse to compare an unknown one", () => {
    assert.equal(compareRates({ value: "200", scale: 4 }, { value: "1", scale: 2 }), 1);
    assert.equal(compareRates({ value: "100", scale: 4 }, { value: "1", scale: 2 }), 0);
    assert.equal(compareRates(null, { value: "1", scale: 2 }), 0);
  });

  it("read as percentages", () => {
    assert.equal(formatRate({ value: "130", scale: 4 }), "1.30%");
    assert.equal(formatRate(null), "unknown");
  });
});

describe("ranking", () => {
  it("ranks options supplying the same asset by base plus incentive", () => {
    const comparison = compareEarn(
      [
        option({ marketId: "a.vault", baseRate: "130" }),
        option({ marketId: "b.vault", baseRate: "90", incentiveRate: "100", incentiveRateScale: 4 }),
        option({ marketId: "c.vault", baseRate: "150" }),
      ],
      NOW,
    );
    assert.equal(comparison.groups.length, 1);
    assert.deepEqual(
      comparison.groups[0]?.rows.map((row) => [row.option.marketId, row.rank]),
      [
        ["b.vault", 1],
        ["c.vault", 2],
        ["a.vault", 3],
      ],
    );
    // 0.90% base plus 1.00% incentive beats 1.50% base alone.
    assert.deepEqual(rowFor(comparison, "b.vault")?.effectiveRate, { value: "190", scale: 4 });
  });

  it("never ranks options that supply different assets against each other", () => {
    const comparison = compareEarn(
      [option({ marketId: "sbtc.vault" }), option({ marketId: "usdcx.vault", suppliedAssetId: USDCX })],
      NOW,
    );
    assert.equal(comparison.groups.length, 2);
    assert.ok(comparison.groups.every((group) => group.rows.every((row) => row.rank === 1)));
    assert.match(comparison.note, /ranked only against others that supply the same asset/);
  });

  it("says when the incentive rate is unknown rather than treating it as nothing", () => {
    const comparison = compareEarn([option()], NOW);
    const row = rowFor(comparison, "zest.sbtc.vault");
    assert.equal(row?.rank, 1);
    assert.ok(row?.notes.some((note) => note.includes("Incentive rate unknown")));
  });
});

describe("what is never ranked", () => {
  const cases: [string, Partial<EarnOption>, RegExp][] = [
    ["supply is not enabled", { supply: { state: "paused", reason: "vault paused" } }, /Supply is paused/],
    ["the market is paused", { paused: true }, /market is paused/],
    ["there is no withdrawal action", { withdrawal: null }, /No withdrawal action/],
    [
      "withdrawal is disabled",
      { withdrawal: { state: "disabled", reason: "not on testnet" } },
      /Withdrawal is disabled/,
    ],
    ["no rate has been read", { baseRate: null, baseRateScale: null }, /No rate has been read/],
    ["the reading is stale", { stale: true }, /last reading is stale/],
    ["the reading is old", { observedAt: "2026-09-18T11:00:00.000Z" }, /Last read 60 minutes ago/],
  ];

  for (const [name, overrides, reason] of cases) {
    it(`does not rank an option when ${name}, and says why`, () => {
      const comparison = compareEarn([option(overrides)], NOW);
      const row = rowFor(comparison, "zest.sbtc.vault");
      assert.equal(row?.rank, null);
      assert.match(row?.notes.join(" ") ?? "", reason);
    });
  }

  it("keeps an unrankable option visible, below the ranked ones", () => {
    const comparison = compareEarn(
      [option({ marketId: "paused.vault", paused: true }), option({ marketId: "live.vault" })],
      NOW,
    );
    assert.deepEqual(
      comparison.groups[0]?.rows.map((row) => [row.option.marketId, row.rank]),
      [
        ["live.vault", 1],
        ["paused.vault", null],
      ],
    );
  });

  it("groups an option with no supplied asset on its own and never ranks it", () => {
    const comparison = compareEarn([option({ marketId: "mystery", suppliedAssetId: null })], NOW);
    assert.equal(comparison.groups[0]?.suppliedAssetId, null);
    assert.equal(comparison.groups[0]?.rows[0]?.rank, 1);
  });

  it("mentions unknown liquidity without refusing to rank", () => {
    const comparison = compareEarn([option({ availableLiquidity: null })], NOW);
    const row = rowFor(comparison, "zest.sbtc.vault");
    assert.equal(row?.rank, 1);
    assert.ok(row?.notes.some((note) => note.includes("liquidity is unknown")));
  });
});
