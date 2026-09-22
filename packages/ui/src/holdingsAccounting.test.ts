import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPortfolio, valuePortfolio } from "./holdings.ts";
import { reconcilePriceQuorum } from "@stacks-capital/core";

describe("I26 UI Canonical Portfolio and Debt Accounting", () => {
  const now = new Date("2026-09-22T00:00:00Z");

  const btcValuation = reconcilePriceQuorum(
    "stacks:mainnet:native:btc",
    [
      {
        source: "dia-oracle",
        price: 6000000000000n, // $60,000 USD
        scale: 8,
        publishedAt: now,
        observedAt: now,
        stale: false,
        warnings: [],
      },
    ],
    { now },
  );

  const usdcValuation = reconcilePriceQuorum(
    "stacks:mainnet:sip10:usdc",
    [
      {
        source: "dia-oracle",
        price: 100000000n, // $1.00 USD
        scale: 8,
        publishedAt: now,
        observedAt: now,
        stale: false,
        warnings: [],
      },
    ],
    { now },
  );

  const stxValuation = reconcilePriceQuorum(
    "stacks:mainnet:native:stx",
    [
      {
        source: "dia-oracle",
        price: 200000000n, // $2.00 USD
        scale: 8,
        publishedAt: now,
        observedAt: now,
        stale: false,
        warnings: [],
      },
    ],
    { now },
  );

  it("visibly links borrowed debt to its backing collateral position", () => {
    const portfolio = buildPortfolio({
      balances: [{ assetId: "stacks:mainnet:native:stx", quantity: "1000000000", stale: false, warnings: [] }],
      positions: [
        // Collateral position: 2 sBTC
        {
          marketId: "granite.sbtc.isolated",
          kind: "collateral",
          assetId: "stacks:mainnet:native:btc",
          quantity: "200000000",
          protocolKey: "granite.sbtc.isolated:collateral",
          stale: false,
          warnings: [],
        },
        // Debt position: 50,000 USDCx
        {
          marketId: "granite.sbtc.isolated",
          kind: "debt",
          assetId: "stacks:mainnet:sip10:usdc",
          quantity: "50000000000",
          protocolKey: "granite.sbtc.isolated:debt",
          stale: false,
          warnings: [],
        },
      ],
      markets: [],
    });

    const debtRow = portfolio.rows.find((r) => r.category === "debt");
    assert.ok(debtRow);
    assert.equal(debtRow.category, "debt");
    assert.ok(debtRow.linkedCollateral);
    assert.equal(debtRow.linkedCollateral.marketId, "granite.sbtc.isolated");
    assert.equal(debtRow.linkedCollateral.assetId, "stacks:mainnet:native:btc");
    assert.equal(debtRow.linkedCollateral.quantity, "200000000");

    const collateralRow = portfolio.rows.find((r) => r.category === "collateral");
    assert.ok(collateralRow);
    assert.equal(collateralRow.category, "collateral");
  });

  it("calculates exact net subtotal: Assets - Debt = Net displayed subtotal exactly", () => {
    const portfolio = buildPortfolio({
      balances: [
        // 1,000 STX ($2,000 USD)
        { assetId: "stacks:mainnet:native:stx", quantity: "1000000000", stale: false, warnings: [] },
      ],
      positions: [
        // 2 sBTC collateral ($120,000 USD)
        {
          marketId: "granite.sbtc.isolated",
          kind: "collateral",
          assetId: "stacks:mainnet:native:btc",
          quantity: "200000000",
          protocolKey: "granite.sbtc.isolated:collateral",
          stale: false,
          warnings: [],
        },
        // 50,000 USDC debt ($50,000 USD)
        {
          marketId: "granite.sbtc.isolated",
          kind: "debt",
          assetId: "stacks:mainnet:sip10:usdc",
          quantity: "50000000000",
          protocolKey: "granite.sbtc.isolated:debt",
          stale: false,
          warnings: [],
        },
      ],
      markets: [],
    });

    const valued = valuePortfolio(portfolio, [btcValuation, usdcValuation, stxValuation]);

    // Gross Assets: 2 BTC ($120,000) + 1000 STX ($2,000) = $122,000 USD
    assert.equal(valued.grossAssetsUsd, "12200000000000");

    // Gross Debt: 50,000 USDC = $50,000 USD
    assert.equal(valued.grossDebtUsd, "5000000000000");

    // Exact Net: 122,000 - 50,000 = $72,000 USD
    assert.equal(valued.netWorthUsd, "7200000000000");
    assert.equal(valued.totalUsd, "7200000000000");

    // Math invariant:
    assert.ok(valued.grossAssetsUsd !== null && valued.grossDebtUsd !== null && valued.netWorthUsd !== null);
    if (valued.grossAssetsUsd && valued.grossDebtUsd && valued.netWorthUsd) {
      assert.equal(BigInt(valued.netWorthUsd) === BigInt(valued.grossAssetsUsd) - BigInt(valued.grossDebtUsd), true);
    }

    // Complete coverage
    assert.equal(valued.coverage.isComplete, true);
    assert.equal(valued.coverage.valuedCount, 3);
  });

  it("normalizes capital categories (wallet, supplied, lp, collateral, debt, locked)", () => {
    const portfolio = buildPortfolio({
      balances: [{ assetId: "stacks:mainnet:native:stx", quantity: "1000000", stale: false, warnings: [] }],
      positions: [
        {
          marketId: "zest.sbtc.vault",
          kind: "supplied",
          assetId: "stacks:mainnet:native:btc",
          quantity: "100",
          stale: false,
          warnings: [],
        },
        {
          marketId: "bitflow.stx-sbtc.pool",
          kind: "lp",
          assetId: "stacks:mainnet:sip10:bitflow-lp",
          quantity: "50",
          stale: false,
          warnings: [],
        },
        {
          marketId: "granite.sbtc.isolated",
          kind: "collateral",
          assetId: "stacks:mainnet:native:btc",
          quantity: "200",
          stale: false,
          warnings: [],
        },
        {
          marketId: "granite.sbtc.isolated",
          kind: "debt",
          assetId: "stacks:mainnet:sip10:usdc",
          quantity: "10000",
          stale: false,
          warnings: [],
        },
        {
          marketId: "stackingdao.stx",
          kind: "locked",
          assetId: "stacks:mainnet:native:stx",
          quantity: "500000",
          stale: false,
          warnings: [],
        },
      ],
      markets: [],
    });

    assert.equal(portfolio.rows.filter((r) => r.category === "wallet").length, 1);
    assert.equal(portfolio.rows.filter((r) => r.category === "supplied").length, 1);
    assert.equal(portfolio.rows.filter((r) => r.category === "lp").length, 1);
    assert.equal(portfolio.rows.filter((r) => r.category === "collateral").length, 1);
    assert.equal(portfolio.rows.filter((r) => r.category === "debt").length, 1);
    assert.equal(portfolio.rows.filter((r) => r.category === "locked").length, 1);
  });
});
