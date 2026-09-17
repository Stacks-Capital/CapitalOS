import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketSnapshotRow, ProjectionTarget } from "@stacks-capital/database";
import { marketSnapshot, RATE_SCALE, reconciliation, type VaultReads } from "./markets.ts";
import { PRICE_MAX_AGE_MS, priceSnapshot } from "./prices.ts";

const AT = new Date("2026-09-17T12:00:00.000Z");
const BLOCK = { height: 9012515, hash: "0xaa" };

const TARGET: ProjectionTarget = {
  marketId: "zest.sbtc.vault",
  protocol: "zest",
  contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
  role: "earn_vault",
  revision: "6162063",
  adapterVersion: "zest-earn@0.1.0",
};

const READS: VaultReads = {
  totalAssets: 66032386443n,
  availableAssets: 58693265572n,
  capSupply: 500000000000n,
  interestRate: 130n,
  pausedDeposit: false,
  pausedRedeem: false,
};

describe("market snapshots", () => {
  it("store what the contract returned, with its block and versions", () => {
    const row = marketSnapshot("mainnet", TARGET, READS, BLOCK, AT);
    assert.deepEqual(
      {
        availableLiquidity: row.availableLiquidity,
        capacity: row.capacity,
        supplyRate: row.supplyRate,
        rateScale: row.rateScale,
        paused: row.paused,
        stale: row.stale,
        warnings: row.warnings,
        blockHeight: row.blockHeight,
        adapterVersion: row.adapterVersion,
      },
      {
        availableLiquidity: "58693265572",
        capacity: "500000000000",
        supplyRate: "130",
        rateScale: RATE_SCALE,
        paused: false,
        stale: false,
        warnings: [],
        blockHeight: 9012515,
        adapterVersion: "zest-earn@0.1.0",
      },
    );
  });

  it("report a market as paused when either side is paused", () => {
    const row = marketSnapshot("mainnet", TARGET, { ...READS, pausedRedeem: true }, BLOCK, AT);
    assert.equal(row.paused, true);
  });

  it("store a missing value as null with a warning, never as zero", () => {
    const row = marketSnapshot("mainnet", TARGET, { ...READS, availableAssets: null, capSupply: null }, BLOCK, AT);
    assert.equal(row.availableLiquidity, null);
    assert.equal(row.capacity, null);
    assert.equal(row.stale, true);
    assert.deepEqual(row.warnings, [
      "zest.sbtc.vault available liquidity is unknown",
      "zest.sbtc.vault supply cap is unknown",
    ]);
  });

  it("store a failed read and an unsupported market as unknown", () => {
    const failed = marketSnapshot("mainnet", TARGET, new Error("HTTP 500"), BLOCK, AT);
    assert.equal(failed.availableLiquidity, null);
    assert.match(failed.warnings[0] ?? "", /read failed: HTTP 500/);

    const deposit = { ...TARGET, marketId: "sbtc.deposit", role: "bridge" };
    const unsupported = marketSnapshot("mainnet", deposit, null, BLOCK, AT);
    assert.equal(unsupported.stale, true);
    assert.deepEqual(unsupported.warnings, ["sbtc.deposit has no onchain read for role bridge"]);
  });

  it("keep a zero balance as a real zero", () => {
    const row = marketSnapshot("mainnet", TARGET, { ...READS, availableAssets: 0n }, BLOCK, AT);
    assert.equal(row.availableLiquidity, "0");
    assert.equal(row.stale, false);
  });
});

describe("price snapshots", () => {
  const fresh = { price: 7653407636305n, publishedAt: new Date(AT.getTime() - 60_000) };

  it("store a fresh price with its publication time", () => {
    const row = priceSnapshot("mainnet", "BTC/USD", fresh, AT);
    assert.deepEqual([row.price, row.priceScale, row.stale, row.warnings], ["7653407636305", 8, false, []]);
    assert.equal(row.publishedAt?.toISOString(), "2026-09-17T11:59:00.000Z");
  });

  it("mark an old price stale but keep the value", () => {
    const old = { price: 6307711986412n, publishedAt: new Date(AT.getTime() - PRICE_MAX_AGE_MS - 60_000) };
    const row = priceSnapshot("mainnet", "sBTC/USD", old, AT);
    assert.equal(row.price, "6307711986412");
    assert.equal(row.stale, true);
    assert.match(row.warnings[0] ?? "", /published 31 minutes ago/);
    const ancient = { price: 6307711986412n, publishedAt: new Date(AT.getTime() - 44 * 24 * 60 * 60 * 1000) };
    assert.match(priceSnapshot("mainnet", "sBTC/USD", ancient, AT).warnings[0] ?? "", /published 44 days ago/);
  });

  it("store an unset feed as unknown with a warning, never as zero", () => {
    for (const reading of [
      { price: 0n, publishedAt: new Date(AT) },
      { price: 1n, publishedAt: null },
      { price: null, publishedAt: null },
    ]) {
      const row = priceSnapshot("mainnet", "USDC/USD", reading, AT);
      assert.equal(row.price, null);
      assert.equal(row.stale, true);
      assert.deepEqual(row.warnings, ["USDC/USD has no price in dia-oracle"]);
    }
  });

  it("store a failed read as unknown with the reason", () => {
    const row = priceSnapshot("mainnet", "BTC/USD", new Error("HTTP 503"), AT);
    assert.equal(row.price, null);
    assert.match(row.warnings[0] ?? "", /read failed: HTTP 503/);
  });
});

describe("reconciliation", () => {
  const observed = marketSnapshot("mainnet", TARGET, READS, BLOCK, AT);
  const earlier = (row: MarketSnapshotRow) => ({ ...row, observedAt: new Date(AT.getTime() - 60_000) });

  it("matches when the projection equals the direct read", () => {
    const run = reconciliation("mainnet", TARGET, earlier(observed), observed, AT);
    assert.equal(run.status, "match");
    assert.equal(run.projected, null);
  });

  it("records a mismatch with both values", () => {
    const projected = earlier({ ...observed, availableLiquidity: "1" });
    const run = reconciliation("mainnet", TARGET, projected, observed, AT);
    assert.equal(run.status, "mismatch");
    assert.match(run.detail, /projected 1\/500000000000, read 58693265572/);
    assert.deepEqual(run.projected, {
      availableLiquidity: "1",
      capacity: "500000000000",
      observedAt: projected.observedAt,
    });
  });

  it("is unavailable when either side has no value, instead of claiming a match", () => {
    const unknown = marketSnapshot("mainnet", TARGET, new Error("HTTP 500"), BLOCK, AT);
    assert.equal(reconciliation("mainnet", TARGET, null, observed, AT).status, "unavailable");
    assert.equal(reconciliation("mainnet", TARGET, earlier(observed), unknown, AT).status, "unavailable");
  });
});
