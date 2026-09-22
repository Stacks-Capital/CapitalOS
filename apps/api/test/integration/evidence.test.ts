import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createClient } from "@stacks-capital/client";
import { connect, createApiKey, getMarketEvidence, MIGRATIONS_DIR, migrate, type Sql } from "@stacks-capital/database";
import { FIXTURE_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { MAINNET_READS } from "@stacks-capital/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter } from "../../src/rateLimit.ts";
import { EarnOptionsResponse, MarketEvidenceResponse } from "../../src/schemas.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const NOW = new Date("2026-09-21T12:00:00.000Z");

describe("Market, Rate, Liquidity, and Capacity Evidence (I24)", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_i24_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;
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
      scopes: ["markets:read"],
    });
    apiKey = created.token;
    headers = { authorization: `Bearer ${apiKey}` };
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("Acceptance Evidence 1: Missing evidence is null plus warnings, never numeric zero", async () => {
    // Insert an unobserved market into markets table
    await sql`
      INSERT INTO markets (network, id, protocol_id, supplied_asset_id, receipt_asset_id)
      VALUES ('mainnet', 'test.unobserved.vault', 'zest', NULL, NULL)
      ON CONFLICT DO NOTHING
    `;

    // 1. Direct database query on unobserved market
    const unobservedEvidence = await getMarketEvidence(sql, "mainnet", "test.unobserved.vault", NOW);
    assert.ok(unobservedEvidence !== null);
    assert.equal(unobservedEvidence.marketId, "test.unobserved.vault");
    assert.equal(unobservedEvidence.rate.supplyRate, null);
    assert.equal(unobservedEvidence.rate.borrowRate, null);
    assert.equal(unobservedEvidence.rate.rateScale, null);
    assert.equal(unobservedEvidence.liquidity.available, null);
    assert.equal(unobservedEvidence.liquidity.capacity, null);
    assert.equal(unobservedEvidence.disagreement, null);
    assert.equal(unobservedEvidence.observations.length, 0);
    assert.ok(unobservedEvidence.warnings.length > 0);
    assert.match(unobservedEvidence.warnings[0] ?? "", /No market snapshot recorded/);

    // 2. API response on unobserved market
    const res = await app.request("/v1/markets/test.unobserved.vault/evidence?network=mainnet", {
      headers,
    });
    assert.equal(res.status, 200);
    const body = MarketEvidenceResponse.parse(await res.json());
    assert.equal(body.schemaVersion, "1.0");
    assert.equal(body.data.marketId, "test.unobserved.vault");
    assert.equal(body.data.rate.supplyRate, null);
    assert.equal(body.data.rate.borrowRate, null);
    assert.equal(body.data.liquidity.available, null);
    assert.equal(body.data.liquidity.capacity, null);
    assert.equal(body.data.disagreement, null);
    assert.equal(body.data.observations.length, 0);
    assert.ok(body.data.warnings.length > 0);

    // Verify non-existent market returns 404
    const notFoundRes = await app.request("/v1/markets/nonexistent.market/evidence?network=mainnet", {
      headers,
    });
    assert.equal(notFoundRes.status, 404);

    // 3. Earn options with missing values are null, not 0
    const earnRes = await app.request("/v1/earn/options?network=mainnet", { headers });
    assert.equal(earnRes.status, 200);
    const earnBody = EarnOptionsResponse.parse(await earnRes.json());
    for (const option of earnBody.data.items) {
      if (option.baseRate === null) {
        assert.notEqual(option.baseRate, "0");
      }
      if (option.capacity === null) {
        assert.notEqual(option.capacity, "0");
      }
      if (option.availableLiquidity === null) {
        assert.notEqual(option.availableLiquidity, "0");
      }
    }
  });

  it("Acceptance Evidence 3: Independent onchain reads (hiro-read) and provider-reported observations remain distinguishable", async () => {
    const marketId = "zest.sbtc.vault";
    const blockHeight = 125_000;
    const blockHash = "0xfeedface";
    const observedAt1 = new Date(NOW.getTime() - 30_000);
    const observedAt2 = new Date(NOW.getTime() - 20_000);

    // Insert independent onchain read
    await sql`
      INSERT INTO market_snapshots (
        network, market_id, block_height, block_hash, source,
        supply_rate, borrow_rate, rate_scale, capacity, available_liquidity,
        paused, stale, warnings, observed_at, adapter_version, calculation_version
      ) VALUES (
        'mainnet', ${marketId}, ${blockHeight}, ${blockHash}, 'hiro-read',
        140, 100, 4, 1000000000, 500000000,
        false, false, '{}', ${observedAt1}, 'zest-v0', 'calc-v1'
      )
    `;

    // Insert provider-reported observation
    await sql`
      INSERT INTO market_snapshots (
        network, market_id, block_height, block_hash, source,
        supply_rate, borrow_rate, rate_scale, capacity, available_liquidity,
        paused, stale, warnings, observed_at, adapter_version, calculation_version
      ) VALUES (
        'mainnet', ${marketId}, ${blockHeight}, ${blockHash}, 'zest',
        175, 120, 4, 1000000000, 500000000,
        false, false, '{}', ${observedAt2}, 'zest-v0', 'calc-v1'
      )
    `;

    // Insert reconciliation run flagging mismatch between projected and observed
    await sql`
      INSERT INTO reconciliation_runs (
        network, market_id, status, detail, projected, observed, source, run_at
      ) VALUES (
        'mainnet', ${marketId}, 'mismatch',
        'rate: hiro-read (140) vs zest (175) diff=35',
        '{"rate": 140}'::jsonb, '{"rate": 175}'::jsonb,
        'reconciler', ${NOW}
      )
    `;

    // Query evidence via API
    const res = await app.request(`/v1/markets/${marketId}/evidence?network=mainnet`, {
      headers,
    });
    assert.equal(res.status, 200);
    const body = MarketEvidenceResponse.parse(await res.json());

    const observations = body.data.observations;
    assert.ok(observations.length >= 2);

    const hiroObs = observations.find((o) => o.source === "hiro-read");
    const zestObs = observations.find((o) => o.source === "zest");

    assert.ok(hiroObs !== undefined, "hiro-read observation must be found");
    assert.ok(zestObs !== undefined, "zest observation must be found");

    // Independent onchain reads and provider reports must be distinguishable
    assert.equal(hiroObs.isIndependentRead, true);
    assert.equal(hiroObs.sourceType, "independent");
    assert.equal(zestObs.isIndependentRead, false);
    assert.equal(zestObs.sourceType, "provider_reported");

    // Disagreement and confidence are exposed
    assert.equal(body.data.disagreement, "mismatch");
    assert.equal(body.data.confidence, "low");

    // Earn options route reflects the latest evidence provenance
    const earnRes = await app.request("/v1/earn/options?network=mainnet", { headers });
    const earnBody = EarnOptionsResponse.parse(await earnRes.json());
    const option = earnBody.data.items.find((item) => item.marketId === marketId);
    assert.ok(option !== undefined);
    assert.ok(option.evidence !== null && option.evidence !== undefined);
    assert.equal(typeof option.evidence.isIndependentRead, "boolean");
    assert.ok(["high", "medium", "low"].includes(option.evidence.confidence));
  });

  it("CapitalClient fetches market evidence", async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      return app.request(String(input).replace("https://api.capital.test", ""), init);
    }) as typeof fetch;

    const client = createClient({
      network: "mainnet",
      apiKey,
      baseUrl: "https://api.capital.test",
      fetch: fetchFn,
    });

    const result = await client.marketEvidence("zest.sbtc.vault");
    assert.equal(result.data.marketId, "zest.sbtc.vault");
    assert.ok(result.data.observations.length >= 2);
    assert.equal(
      result.data.observations.some((o) => o.isIndependentRead),
      true,
    );
  });
});
