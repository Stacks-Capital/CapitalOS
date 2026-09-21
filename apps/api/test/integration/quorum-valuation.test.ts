import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createClient } from "@stacks-capital/client";
import {
  connect,
  createApiKey,
  latestPriceValuations,
  MIGRATIONS_DIR,
  migrate,
  type Sql,
} from "@stacks-capital/database";
import { evaluatePortfolioValuation } from "@stacks-capital/core";
import { FIXTURE_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { MAINNET_READS } from "@stacks-capital/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter } from "../../src/rateLimit.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const NOW = new Date("2026-09-22T00:00:00.000Z");

describe("Price and Oracle Quorum Valuation (I25)", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_i25_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let app: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createClient>;
  let apiKey: string;

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);

    app = createApp({
      sql,
      limiter: memoryLimiter(),
      now: () => NOW,
      reads: MAINNET_READS,
    });

    const created = await createApiKey(sql, {
      appId: FIXTURE_APP.id,
      scopes: ["markets:read", "positions:read", "quotes:write"],
    });
    apiKey = created.token;

    client = createClient({
      network: "mainnet",
      baseUrl: "http://localhost:3000",
      apiKey,
      fetch: (async (input, init) => {
        const path = typeof input === "string" ? input.replace("http://localhost:3000", "") : "";
        return app.request(path, init);
      }) as typeof fetch,
    });
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("Acceptance Evidence 1: Every valuation carries asset ID, price, source set and timestamp", async () => {
    // Insert multi-source agreeing price snapshots for BTC/USD and STX/USD
    await sql`
      INSERT INTO price_snapshots (network, feed_key, price, price_scale, published_at, stale, warnings, source, observed_at)
      VALUES
        ('mainnet', 'BTC/USD', 6000000000000, 8, ${NOW}, false, '{}', 'dia-oracle', ${NOW}),
        ('mainnet', 'BTC/USD', 6010000000000, 8, ${NOW}, false, '{}', 'pyth-oracle', ${NOW}),
        ('mainnet', 'STX/USD', 200000000, 8, ${NOW}, false, '{}', 'dia-oracle', ${NOW})
    `;

    // 1. Direct database helper
    const valuations = await latestPriceValuations(sql, "mainnet", ["BTC/USD", "STX/USD"], { now: NOW });
    assert.equal(valuations.length, 2);

    const btcValuation = valuations.find((v) => v.assetId === "BTC/USD");
    assert.ok(btcValuation);
    assert.equal(btcValuation.assetId, "BTC/USD");
    assert.ok(btcValuation.price !== null);
    assert.deepEqual(btcValuation.sourceSet.sort(), ["dia-oracle", "pyth-oracle"].sort());
    assert.equal(btcValuation.timestamp, NOW.toISOString());
    assert.equal(btcValuation.status, "verified");
    assert.equal(btcValuation.disagreement, false);

    // 2. Client SDK and REST API
    const res = await client.priceValuations();
    assert.ok(res.data.items.length >= 2);

    const apiBtc = res.data.items.find((item) => item.assetId === "BTC/USD");
    assert.ok(apiBtc);
    assert.equal(apiBtc.assetId, "BTC/USD");
    assert.ok(apiBtc.price !== null);
    assert.deepEqual(apiBtc.sourceSet.sort(), ["dia-oracle", "pyth-oracle"].sort());
    assert.equal(apiBtc.timestamp, NOW.toISOString());
    assert.equal(apiBtc.status, "verified");
    assert.equal(apiBtc.disagreement, false);

    // 3. /v1/prices route also carries sourceSet, disagreement and status
    const pricesRes = await client.prices();
    const btcPrice = pricesRes.data.items.find((item) => item.feedKey === "BTC/USD");
    assert.ok(btcPrice);
    assert.deepEqual(btcPrice.sourceSet?.sort(), ["dia-oracle", "pyth-oracle"].sort());
    assert.equal(btcPrice.disagreement, false);
    assert.equal(btcPrice.status, "verified");
  });

  it("Acceptance Evidence 2: Quorum disagreement fails closed for actions", async () => {
    const at = new Date(NOW.getTime() + 1000);

    // Insert disagreeing price snapshots for BTC/USD: dia says 60,000, pyth says 75,000 (2500 bps spread > 300 bps tolerance)
    await sql`
      INSERT INTO price_snapshots (network, feed_key, price, price_scale, published_at, stale, warnings, source, observed_at)
      VALUES
        ('mainnet', 'BTC/USD', 6000000000000, 8, ${at}, false, '{}', 'dia-oracle', ${at}),
        ('mainnet', 'BTC/USD', 7500000000000, 8, ${at}, false, '{}', 'pyth-oracle', ${at}),
        ('mainnet', 'USDC/USD', 100000000, 8, ${at}, false, '{}', 'dia-oracle', ${at})
    `;

    // 1. Database valuation marks disagreement
    const valuations = await latestPriceValuations(sql, "mainnet", ["BTC/USD"], { now: at });
    const btcValuation = valuations[0];
    assert.ok(btcValuation);
    assert.equal(btcValuation.status, "disputed");
    assert.equal(btcValuation.disagreement, true);
    assert.equal(btcValuation.price, null); // Withheld!
    assert.ok(btcValuation.spreadBps !== null && btcValuation.spreadBps > 2000);

    // 2. Market risk endpoint discloses quorum dispute
    const riskRes = await client.marketRisk("granite.sbtc.isolated");
    assert.equal(riskRes.data.collateralOracle.disagreement, true);
    assert.equal(riskRes.data.collateralOracle.status, "disputed");
    assert.equal(riskRes.data.collateralOracle.price, null);

    // 3. Quoting an action that depends on this oracle fails closed with 409 QUORUM_DISAGREEMENT
    const quoteReq = await app.request("/v1/quotes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        network: "mainnet",
        action: "borrow",
        marketId: "granite.sbtc.isolated",
        amount: "1000000",
        owner: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
      }),
    });

    assert.equal(quoteReq.status, 409);
    const errBody = (await quoteReq.json()) as { error: { code: string; message: string } };
    assert.equal(errBody.error.code, "QUORUM_DISAGREEMENT");
    assert.ok(errBody.error.message.includes("Quorum disagreement"));
  });

  it("Acceptance Evidence 3: Partial portfolio totals disclose valued and unvalued coverage", async () => {
    const holdings = [
      { assetId: "stacks:mainnet:native:btc", quantity: "100000000" }, // 1 BTC = $60,000
      { assetId: "stacks:mainnet:native:stx", quantity: "1000000000" }, // 1000 STX = $2,000
      { assetId: "stacks:mainnet:sip10:unsupported-token", quantity: "5000000" }, // Unsupported!
    ];

    const valuations = [
      {
        assetId: "stacks:mainnet:native:btc",
        price: "6000000000000",
        scale: 8,
        sourceSet: ["dia-oracle"],
        timestamp: NOW.toISOString(),
        status: "verified" as const,
        disagreement: false,
        spreadBps: null,
        warnings: [],
      },
      {
        assetId: "stacks:mainnet:native:stx",
        price: "200000000",
        scale: 8,
        sourceSet: ["dia-oracle"],
        timestamp: NOW.toISOString(),
        status: "verified" as const,
        disagreement: false,
        spreadBps: null,
        warnings: [],
      },
      {
        assetId: "stacks:mainnet:sip10:unsupported-token",
        price: null,
        scale: 8,
        sourceSet: [],
        timestamp: NOW.toISOString(),
        status: "unsupported" as const,
        disagreement: false,
        spreadBps: null,
        warnings: ["Asset stacks:mainnet:sip10:unsupported-token has no supported price oracle feed"],
      },
    ];

    const result = evaluatePortfolioValuation(holdings, valuations);

    // 1. Verified values are not withheld ($60,000 + $2,000 = $62,000)
    assert.equal(result.totalUsd, "6200000000000");

    // 2. Unsupported asset is clearly labeled
    const unsupported = result.items.find((i) => i.assetId === "stacks:mainnet:sip10:unsupported-token");
    assert.ok(unsupported);
    assert.equal(unsupported.status, "unsupported");
    assert.equal(unsupported.usdValue, null);
    assert.ok(unsupported.unvaluedReason?.includes("no supported price oracle feed"));

    // 3. Partial portfolio coverage is explicitly disclosed
    assert.equal(result.coverage.isComplete, false);
    assert.equal(result.coverage.valuedCount, 2);
    assert.equal(result.coverage.unvaluedCount, 1);
    assert.equal(result.coverage.totalCount, 3);
    assert.equal(result.coverage.coverageBps, 6667);
    assert.deepEqual(result.coverage.valuedAssets, ["stacks:mainnet:native:btc", "stacks:mainnet:native:stx"]);
    assert.equal(result.coverage.unvaluedAssets.length, 1);
    const unval = result.coverage.unvaluedAssets[0];
    assert.ok(unval);
    assert.equal(unval.assetId, "stacks:mainnet:sip10:unsupported-token");
  });
});
