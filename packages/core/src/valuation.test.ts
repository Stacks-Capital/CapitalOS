import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCapitalError } from "./errors.ts";
import {
  computeHealth,
  evaluatePortfolioValuation,
  graniteProtectiveActions,
  interpretGraniteHealth,
  reconcilePriceQuorum,
  assertOracleQuorum,
} from "./index.ts";

describe("I25 Price and oracle quorum valuation", () => {
  const now = new Date("2026-09-22T00:00:00Z");

  describe("reconcilePriceQuorum", () => {
    it("every valuation carries asset ID, price, source set and timestamp", () => {
      const valuation = reconcilePriceQuorum(
        "stacks:mainnet:native:btc",
        [
          {
            source: "dia-oracle",
            price: 60_000_0000_0000n, // $60,000 with scale 8
            scale: 8,
            publishedAt: "2026-09-22T00:00:00Z",
            observedAt: "2026-09-22T00:00:00Z",
            stale: false,
          },
        ],
        { now },
      );

      assert.equal(valuation.assetId, "stacks:mainnet:native:btc");
      assert.equal(valuation.price, "6000000000000");
      assert.deepEqual(valuation.sourceSet, ["dia-oracle"]);
      assert.equal(valuation.timestamp, "2026-09-22T00:00:00Z");
      assert.equal(valuation.status, "verified");
      assert.equal(valuation.disagreement, false);
      assert.equal(valuation.scale, 8);
    });

    it("reconciles multiple independent sources within tolerance", () => {
      const valuation = reconcilePriceQuorum(
        "stacks:mainnet:native:btc",
        [
          {
            source: "dia-oracle",
            price: 60_000_0000_0000n,
            scale: 8,
            publishedAt: "2026-09-22T00:00:00Z",
            observedAt: "2026-09-22T00:00:00Z",
            stale: false,
          },
          {
            source: "pyth-oracle",
            price: 60_500_0000_0000n, // ~83 bps spread, within 300 bps
            scale: 8,
            publishedAt: "2026-09-22T00:00:01Z",
            observedAt: "2026-09-22T00:00:01Z",
            stale: false,
          },
        ],
        { now },
      );

      assert.equal(valuation.status, "verified");
      assert.equal(valuation.disagreement, false);
      assert.deepEqual(valuation.sourceSet.sort(), ["dia-oracle", "pyth-oracle"].sort());
      assert.ok(valuation.spreadBps !== null && valuation.spreadBps <= 100);
      assert.ok(valuation.price !== null);
    });

    it("quorum disagreement fails closed when spread exceeds max tolerance", () => {
      const valuation = reconcilePriceQuorum(
        "stacks:mainnet:native:btc",
        [
          {
            source: "dia-oracle",
            price: 60_000_0000_0000n,
            scale: 8,
            publishedAt: "2026-09-22T00:00:00Z",
            observedAt: "2026-09-22T00:00:00Z",
            stale: false,
          },
          {
            source: "pyth-oracle",
            price: 65_000_0000_0000n, // 833 bps spread, exceeds 300 bps
            scale: 8,
            publishedAt: "2026-09-22T00:00:01Z",
            observedAt: "2026-09-22T00:00:01Z",
            stale: false,
          },
        ],
        { now },
      );

      // Fails closed: disagreement is true, status is disputed, price is withheld (null)
      assert.equal(valuation.status, "disputed");
      assert.equal(valuation.disagreement, true);
      assert.equal(valuation.price, null);
      assert.deepEqual(valuation.sourceSet.sort(), ["dia-oracle", "pyth-oracle"].sort());
      assert.ok(valuation.spreadBps !== null && valuation.spreadBps > 800);
      assert.ok(valuation.warnings.some((w) => w.includes("Quorum disagreement")));
    });

    it("labels unsupported assets when readings are empty", () => {
      const valuation = reconcilePriceQuorum("stacks:mainnet:sip10:unsupported-token", [], { now });

      assert.equal(valuation.status, "unsupported");
      assert.equal(valuation.price, null);
      assert.deepEqual(valuation.sourceSet, []);
      assert.equal(valuation.disagreement, false);
      assert.ok(valuation.warnings.some((w) => w.includes("no supported price oracle")));
    });

    it("labels stale assets when readings are stale", () => {
      const valuation = reconcilePriceQuorum(
        "stacks:mainnet:native:btc",
        [
          {
            source: "dia-oracle",
            price: 60_000_0000_0000n,
            scale: 8,
            publishedAt: "2026-09-22T00:00:00Z",
            observedAt: "2026-09-22T00:00:00Z",
            stale: true,
          },
        ],
        { now },
      );

      assert.equal(valuation.status, "stale");
      assert.equal(valuation.price, null);
    });
  });

  describe("Fail-closed action semantics", () => {
    it("assertOracleQuorum throws QUORUM_DISAGREEMENT for disputed oracles", () => {
      assert.throws(
        () => {
          assertOracleQuorum(
            {
              price: 60_000_0000_0000n,
              scale: 8n,
              observedAt: now.toISOString(),
              source: "multi",
              stale: false,
              maxAgeMs: 180_000,
              disagreement: true,
              status: "disputed",
            },
            "BTC/USD",
          );
        },
        (err: unknown) => {
          assert.ok(isCapitalError(err));
          assert.equal(err.code, "QUORUM_DISAGREEMENT");
          assert.equal(err.class, "requote");
          assert.ok(err.message.includes("quorum disagreement"));
          return true;
        },
      );
    });

    it("computeHealth fails closed when oracle has quorum disagreement", () => {
      const health = computeHealth({
        collateral: {
          amount: 1_0000_0000n, // 1 sBTC
          decimals: 8n,
          oracle: {
            price: 60_000_0000_0000n,
            scale: 8n,
            observedAt: now.toISOString(),
            source: "multi",
            stale: false,
            maxAgeMs: 180_000,
            disagreement: true, // Quorum dispute!
          },
        },
        debt: {
          amount: 10_000_0000_0000n, // 10,000 USDCx
          decimals: 8n,
          oracle: {
            price: 1_0000_0000n,
            scale: 8n,
            observedAt: now.toISOString(),
            source: "dia",
            stale: false,
            maxAgeMs: 180_000,
            disagreement: false,
          },
        },
        params: {
          ltvBorrowBps: 7000n,
          ltvLiqBps: 8000n,
          bufferBps: 500n,
        },
        now,
      });

      assert.equal(health.healthy, false);
      assert.equal(health.stale, true);
      assert.equal(health.collateralUsd, 0n);
      assert.ok(health.warnings.some((w) => w.includes("quorum disagreement")));

      // Granite health interpretation explains quorum dispute
      const interpretation = interpretGraniteHealth(health, {
        ltvBorrowBps: 7000n,
        ltvLiqBps: 8000n,
        bufferBps: 500n,
      });
      assert.ok(interpretation.meaning.includes("quorum disagreement"));

      // Protective actions deny actions due to quorum dispute
      const actions = graniteProtectiveActions({ health });
      const borrowAction = actions.actions.find((a) => a.action === "borrow");
      assert.equal(borrowAction?.allowed, false);
      assert.ok(borrowAction?.reason.includes("quorum disagreement"));
    });
  });

  describe("Portfolio valuation and partial coverage", () => {
    it("labels unsupported assets without withholding unrelated verified values", () => {
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
              price: 2_0000_0000n, // $2.00
              scale: 8,
              publishedAt: now.toISOString(),
              observedAt: now.toISOString(),
              stale: false,
            },
          ],
          { now },
        ),
      ];

      const holdings = [
        { assetId: "stacks:mainnet:native:btc", quantity: "100000000", decimals: 8 }, // 1 BTC = $60,000
        { assetId: "stacks:mainnet:native:stx", quantity: "500000000", decimals: 6 }, // 500 STX = $1,000
        { assetId: "stacks:mainnet:sip10:unsupported-token", quantity: "1000000", decimals: 6 }, // Unsupported!
      ];

      const result = evaluatePortfolioValuation(holdings, valuations);

      // Verified assets are valued and sum together ($60,000 + $1,000 = $61,000)
      // They are NOT withheld because of the unsupported token!
      assert.equal(result.totalUsd, "6100000000000"); // $61,000 with 8 decimals

      // Unsupported token is explicitly labeled
      const unsupportedItem = result.items.find((i) => i.assetId === "stacks:mainnet:sip10:unsupported-token");
      assert.ok(unsupportedItem);
      assert.equal(unsupportedItem.status, "unsupported");
      assert.equal(unsupportedItem.usdValue, null);
      assert.ok(unsupportedItem.unvaluedReason?.includes("no supported price oracle feed"));

      // Partial portfolio coverage is disclosed
      assert.equal(result.coverage.isComplete, false);
      assert.equal(result.coverage.valuedCount, 2);
      assert.equal(result.coverage.unvaluedCount, 1);
      assert.equal(result.coverage.totalCount, 3);
      assert.equal(result.coverage.coverageBps, 6667); // 2/3 = 66.67%
      assert.deepEqual(result.coverage.valuedAssets, ["stacks:mainnet:native:btc", "stacks:mainnet:native:stx"]);
      assert.equal(result.coverage.unvaluedAssets.length, 1);
      assert.equal(result.coverage.unvaluedAssets[0]?.assetId, "stacks:mainnet:sip10:unsupported-token");
    });

    it("withholds disputed asset from subtotal while preserving verified ones", () => {
      const btcValuation = reconcilePriceQuorum(
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
      );

      // Disputed STX valuation (spread > 300 bps)
      const stxValuation = reconcilePriceQuorum(
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
          {
            source: "pyth-oracle",
            price: 2_5000_0000n, // 25% difference!
            scale: 8,
            publishedAt: now.toISOString(),
            observedAt: now.toISOString(),
            stale: false,
          },
        ],
        { now },
      );

      const holdings = [
        { assetId: "stacks:mainnet:native:btc", quantity: "100000000", decimals: 8 },
        { assetId: "stacks:mainnet:native:stx", quantity: "500000000", decimals: 6 },
      ];

      const result = evaluatePortfolioValuation(holdings, [btcValuation, stxValuation]);

      // BTC value is preserved ($60,000), STX is excluded due to dispute
      assert.equal(result.totalUsd, "6000000000000");

      const stxItem = result.items.find((i) => i.assetId === "stacks:mainnet:native:stx");
      assert.equal(stxItem?.status, "disputed");
      assert.equal(stxItem?.usdValue, null);
      assert.ok(stxItem?.unvaluedReason?.includes("Quorum disagreement"));

      assert.equal(result.coverage.isComplete, false);
      assert.equal(result.coverage.valuedCount, 1);
      assert.equal(result.coverage.unvaluedCount, 1);
    });
  });
});
