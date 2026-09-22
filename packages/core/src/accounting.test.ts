import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AccountingEntry, evaluatePortfolioAccounting, normalizeCapitalCategory } from "./accounting.ts";
import { reconcilePriceQuorum } from "./valuation.ts";

describe("I26 Core Portfolio and Debt Accounting", () => {
  const now = new Date("2026-09-22T00:00:00Z");

  const btcValuation = reconcilePriceQuorum(
    "stacks:mainnet:native:btc",
    [
      {
        source: "dia-oracle",
        price: 6000000000000n, // $60,000 USD (scale 8)
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
        price: 100000000n, // $1.00 USD (scale 8)
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
        price: 200000000n, // $2.00 USD (scale 8)
        scale: 8,
        publishedAt: now,
        observedAt: now,
        stale: false,
        warnings: [],
      },
    ],
    { now },
  );

  it("normalizes all 6 capital categories", () => {
    assert.equal(normalizeCapitalCategory("wallet"), "wallet");
    assert.equal(normalizeCapitalCategory("supplied"), "supplied");
    assert.equal(normalizeCapitalCategory("supply"), "supplied");
    assert.equal(normalizeCapitalCategory("lp"), "lp");
    assert.equal(normalizeCapitalCategory("pool"), "lp");
    assert.equal(normalizeCapitalCategory("collateral"), "collateral");
    assert.equal(normalizeCapitalCategory("debt"), "debt");
    assert.equal(normalizeCapitalCategory("borrow"), "debt");
    assert.equal(normalizeCapitalCategory("locked"), "locked");
    assert.equal(normalizeCapitalCategory("staked"), "locked");
    assert.equal(normalizeCapitalCategory("unknown_thing"), null);
  });

  it("calculates exact net subtotal: grossAssetsUsd - grossDebtUsd === netWorthUsd", () => {
    const entries: AccountingEntry[] = [
      // 1. Wallet: 1,000 STX = $2,000 USD (200,000,000,000 in 10^-8)
      {
        id: "entry-wallet-stx",
        category: "wallet",
        assetId: "stacks:mainnet:native:stx",
        quantity: "1000000000", // 1000 STX (scale 6)
        marketId: null,
        protocolKey: null,
        isReceipt: false,
        countsTowardTotal: true,
        linkedCollateral: null,
        stale: false,
        warnings: [],
      },
      // 2. Collateral: 2 sBTC = $120,000 USD (12,000,000,000,000 in 10^-8)
      {
        id: "entry-collateral-btc",
        category: "collateral",
        assetId: "stacks:mainnet:native:btc",
        quantity: "200000000", // 2 BTC (scale 8)
        marketId: "granite.sbtc.isolated",
        protocolKey: "granite.sbtc.isolated:collateral",
        isReceipt: false,
        countsTowardTotal: true,
        linkedCollateral: null,
        stale: false,
        warnings: [],
      },
      // 3. Debt: 50,000 USDC = $50,000 USD (5,000,000,000,000 in 10^-8) backed by sBTC collateral
      {
        id: "entry-debt-usdc",
        category: "debt",
        assetId: "stacks:mainnet:sip10:usdc",
        quantity: "50000000000", // 50,000 USDC (scale 6)
        marketId: "granite.sbtc.isolated",
        protocolKey: "granite.sbtc.isolated:debt",
        isReceipt: false,
        countsTowardTotal: true,
        linkedCollateral: {
          marketId: "granite.sbtc.isolated",
          assetId: "stacks:mainnet:native:btc",
          protocolKey: "granite.sbtc.isolated:collateral",
          quantity: "200000000",
        },
        stale: false,
        warnings: [],
      },
    ];

    const result = evaluatePortfolioAccounting(entries, [btcValuation, usdcValuation, stxValuation]);

    // Gross assets = $2,000 (STX) + $120,000 (sBTC) = $122,000 USD = 12200000000000
    assert.equal(result.grossAssetsUsd, "12200000000000");

    // Gross debt = $50,000 USD = 5000000000000
    assert.equal(result.grossDebtUsd, "5000000000000");

    // Exact net worth = 122,000 - 50,000 = $72,000 USD = 7200000000000
    assert.equal(result.netWorthUsd, "7200000000000");

    // Invariant check:
    assert.ok(result.grossAssetsUsd !== null && result.grossDebtUsd !== null);
    if (result.grossAssetsUsd && result.grossDebtUsd) {
      assert.equal(BigInt(result.netWorthUsd) === BigInt(result.grossAssetsUsd) - BigInt(result.grossDebtUsd), true);
    }

    // Debt visibly linked to collateral
    const debtEntry = entries.find((e) => e.category === "debt");
    assert.ok(debtEntry?.linkedCollateral);
    assert.equal(debtEntry?.linkedCollateral.marketId, "granite.sbtc.isolated");
    assert.equal(debtEntry?.linkedCollateral.assetId, "stacks:mainnet:native:btc");

    // Category breakdown
    assert.equal(result.byCategory.wallet.totalUsd, "200000000000");
    assert.equal(result.byCategory.collateral.totalUsd, "12000000000000");
    assert.equal(result.byCategory.debt.totalUsd, "5000000000000");
  });

  it("prevents double-counting of receipt tokens vs underlying protocol claims", () => {
    const entries: AccountingEntry[] = [
      // Protocol supplied position: 1 sBTC in Zest = $60,000 USD
      {
        id: "entry-supplied-btc",
        category: "supplied",
        assetId: "stacks:mainnet:native:btc",
        quantity: "100000000",
        marketId: "zest.sbtc.vault",
        protocolKey: "zest.sbtc.vault:supplied",
        isReceipt: false,
        countsTowardTotal: true,
        linkedCollateral: null,
        stale: false,
        warnings: [],
      },
      // Receipt token zsBTC in wallet: represents the same money! Must NOT count toward total
      {
        id: "entry-receipt-zsbtc",
        category: "wallet",
        assetId: "stacks:mainnet:sip10:zsbtc",
        quantity: "100000000",
        marketId: "zest.sbtc.vault",
        protocolKey: null,
        isReceipt: true,
        countsTowardTotal: false, // Deduplicated!
        linkedCollateral: null,
        stale: false,
        warnings: ["Receipt for zest.sbtc.vault. Represented by protocol position."],
      },
    ];

    const result = evaluatePortfolioAccounting(entries, [btcValuation]);

    // Only 1 BTC counted, zsBTC is omitted from totals without losing evidence
    assert.equal(result.grossAssetsUsd, "6000000000000");
    assert.equal(result.netWorthUsd, "6000000000000");
    assert.ok(result.warnings.some((w) => w.includes("Receipt")));
  });

  it("transparently discloses coverage when an asset lacks an oracle valuation", () => {
    const entries: AccountingEntry[] = [
      {
        id: "entry-btc",
        category: "wallet",
        assetId: "stacks:mainnet:native:btc",
        quantity: "100000000", // $60,000
        marketId: null,
        protocolKey: null,
        isReceipt: false,
        countsTowardTotal: true,
        linkedCollateral: null,
        stale: false,
        warnings: [],
      },
      {
        id: "entry-unsupported",
        category: "wallet",
        assetId: "stacks:mainnet:sip10:unsupported-meme",
        quantity: "1000000000",
        marketId: null,
        protocolKey: null,
        isReceipt: false,
        countsTowardTotal: true,
        linkedCollateral: null,
        stale: false,
        warnings: [],
      },
    ];

    const result = evaluatePortfolioAccounting(entries, [btcValuation]);

    // Partial coverage disclosed
    assert.equal(result.coverage.isComplete, false);
    assert.equal(result.coverage.valuedCount, 1);
    assert.equal(result.coverage.unvaluedCount, 1);
    assert.equal(result.coverage.totalCount, 2);
    assert.equal(result.coverage.coverageBps, 5000);

    const unval = result.coverage.unvaluedAssets[0];
    assert.ok(unval);
    assert.equal(unval.assetId, "stacks:mainnet:sip10:unsupported-meme");
    assert.ok(unval.reason.includes("no supported price oracle feed"));
  });
});
