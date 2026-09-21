import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPortfolio, valuePortfolio } from "./holdings.ts";
import { projectBorrow } from "./borrow.ts";
import type { MarketRisk } from "@stacks-capital/client";
import { reconcilePriceQuorum } from "@stacks-capital/core";

describe("I25 UI holdings valuation and borrow guards", () => {
  const now = new Date("2026-09-22T00:00:00Z");

  it("values portfolio totals and provides explicit coverage disclosure", () => {
    const portfolio = buildPortfolio({
      balances: [
        { assetId: "stacks:mainnet:native:btc", quantity: "100000000", stale: false, warnings: [] },
        { assetId: "stacks:mainnet:native:stx", quantity: "1000000000", stale: false, warnings: [] },
        { assetId: "stacks:mainnet:sip10:unsupported-token", quantity: "5000000", stale: false, warnings: [] },
      ],
      positions: [],
      markets: [],
    });

    const valuations = [
      reconcilePriceQuorum(
        "stacks:mainnet:native:btc",
        [
          {
            source: "dia-oracle",
            price: 60_000_0000_0000n,
            scale: 8,
            publishedAt: now.toISOString(),
            observedAt: now.toISOString(),
            stale: false,
          },
        ],
        { now },
      ),
      reconcilePriceQuorum(
        "stacks:mainnet:native:stx",
        [
          {
            source: "dia-oracle",
            price: 2_0000_0000n,
            scale: 8,
            publishedAt: now.toISOString(),
            observedAt: now.toISOString(),
            stale: false,
          },
        ],
        { now },
      ),
    ];

    const result = valuePortfolio(portfolio, valuations);

    // Verified assets sum together without withholding:
    // 1 BTC ($60,000) + 1000 STX ($2,000) = $62,000 USD
    assert.equal(result.totalUsd, "6200000000000");

    // Unsupported token is explicitly disclosed
    assert.equal(result.coverage.isComplete, false);
    assert.equal(result.coverage.valuedCount, 2);
    assert.equal(result.coverage.unvaluedCount, 1);
    assert.equal(result.coverage.totalCount, 3);
    assert.equal(result.coverage.coverageBps, 6667);

    const unsupported = result.coverage.unvaluedAssets[0];
    assert.ok(unsupported);
    assert.equal(unsupported.assetId, "stacks:mainnet:sip10:unsupported-token");
    assert.ok(unsupported.reason.includes("no supported price oracle feed"));
  });

  it("projectBorrow blocks actions when collateral or debt oracle has quorum disagreement", () => {
    const risk: MarketRisk = {
      marketId: "granite.sbtc.credit",
      params: {
        ltvBorrowBps: "7000",
        ltvLiqBps: "8000",
        bufferBps: "500",
        collateralDecimals: 8,
        debtDecimals: 6,
      },
      collateralOracle: {
        feedKey: "BTC/USD",
        price: null, // withheld due to dispute
        scale: 8,
        publishedAt: now.toISOString(),
        observedAt: now.toISOString(),
        source: "dia-oracle, pyth-oracle",
        stale: false,
        warnings: ["Quorum disagreement between price sources"],
        disagreement: true, // Disputed!
        status: "disputed",
      },
      debtOracle: {
        feedKey: "USDC/USD",
        price: "100000000",
        scale: 8,
        publishedAt: now.toISOString(),
        observedAt: now.toISOString(),
        source: "dia-oracle",
        stale: false,
        warnings: [],
        disagreement: false,
        status: "verified",
      },
      position: { collateral: "100000000", debt: "10000000", stale: false, warnings: [] },
      warnings: [],
    };

    const projection = projectBorrow(
      risk,
      {
        action: "borrow",
        amount: "1000000",
        paused: false,
        walletBalance: "5000000",
        availableLiquidity: "1000000000",
      },
      now,
    );

    // Financial actions fail closed: quorum disagreement blocker is present
    assert.ok(projection.blockers.some((b) => b.includes("quorum disagreement") && b.includes("BTC/USD")));
  });
});
