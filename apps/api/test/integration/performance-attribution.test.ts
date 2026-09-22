import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createClient } from "@stacks-capital/client";
import { connect, createApiKey, MIGRATIONS_DIR, migrate, type Sql } from "@stacks-capital/database";
import { FIXTURE_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { MAINNET_READS } from "@stacks-capital/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter } from "../../src/rateLimit.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const NOW = new Date("2026-09-22T00:00:00.000Z");

describe("Attribute Earned Yield, Rewards and Historical Performance (I27)", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_i27_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let app: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createClient>;
  let apiKey: string;

  const TEST_OWNER = "SP1P72Z3704VMT3DMHPP2CB8TGQWGDBHD3RPR9GZS";
  const SBTC_ASSET = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
  const ZEST_MARKET = "zest.sbtc.vault";

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

  it("Acceptance Evidence 1: No balance increase is called yield without cash-flow attribution", async () => {
    // 1. Insert a completed deposit workflow of 1.0 sBTC (100,000,000 units)
    const quoteId = `quote_deposit_${randomBytes(4).toString("hex")}`;
    const workflowId = `wf_deposit_${randomBytes(4).toString("hex")}`;

    await sql`
      INSERT INTO quotes (id, network, market_id, action, input, expected_output, minimum_output, fees, snapshots, warnings, executable, registry_version, adapter_version, expires_at)
      VALUES (
        ${quoteId}, 'mainnet', ${ZEST_MARKET}, 'supply',
        ${sql.json([{ asset: SBTC_ASSET, quantity: "100000000" }])},
        ${sql.json([{ asset: SBTC_ASSET, quantity: "100000000" }])},
        null, '[]', '{}', '{}', true, '1.0.0', '1.0.0', ${NOW}
      )
    `;

    await sql`
      INSERT INTO workflows (id, network, idempotency_key, quote_id, state, next_action, owner_address, created_at, updated_at)
      VALUES (
        ${workflowId}, 'mainnet', ${randomBytes(8).toString("hex")}, ${quoteId}, 'COMPLETED', 'COMPLETE', ${TEST_OWNER}, ${NOW}, ${NOW}
      )
    `;

    const [zestDep] = await sql<{ id: string }[]>`
      SELECT id FROM deployments WHERE network = 'mainnet' AND protocol_id = 'zest' LIMIT 1
    `;
    assert.ok(zestDep);
    const ZEST_DEPLOYMENT = zestDep.id;

    // 2. Insert position snapshot showing 150,000,000 units (an unexplained 50M increase)
    await sql`
      INSERT INTO position_snapshots (owner, network, deployment_id, market_id, kind, protocol_key, asset_id, quantity, stale, warnings, source, observed_at, block_height, block_hash, adapter_version, calculation_version)
      VALUES (
        ${TEST_OWNER}, 'mainnet', ${ZEST_DEPLOYMENT}, ${ZEST_MARKET}, 'supplied', 'primary', ${SBTC_ASSET},
        150000000, false, '{}', 'hiro-read', ${NOW}, 185000, '0xabc123', '1.0.0', '1.0.0'
      )
    `;

    // 3. Query earn performance
    const res = await client.earnPerformance({ owner: TEST_OWNER, marketId: ZEST_MARKET });
    assert.ok(res.data.items.length > 0);
    const item = res.data.items.find((i) => i.marketId === ZEST_MARKET);
    assert.ok(item);

    // CRITICAL: The 50,000,000 increase MUST NOT be classified as earned yield!
    assert.equal(item.attribution.earnedYield, "0");
    assert.equal(item.attribution.unattributedInflow, "50000000");
    assert.equal(item.attribution.hasUnattributedInflow, true);
    assert.equal(item.attribution.depositsTotal, "100000000");
    assert.equal(item.attribution.costBasis, "100000000");
    assert.ok(item.attribution.warnings.length > 0);
    assert.match(item.attribution.warnings[0]!, /unattributed inflow and excluded from earned yield/);
  });

  it("Acceptance Evidence 2: Thirty-day projections require current verified rates", async () => {
    // Case 1: Market with verified rate (500 bps = 5.00%, fresh, matching reconciliation)
    await sql`
      INSERT INTO market_snapshots (network, market_id, supply_rate, borrow_rate, rate_scale, available_liquidity, capacity, paused, stale, warnings, source, observed_at, block_height, block_hash, adapter_version, calculation_version)
      VALUES (
        'mainnet', ${ZEST_MARKET}, 500, null, 4, 1000000000, 5000000000, false, false, '{}', 'hiro-read', ${NOW}, 185000, '0xabc123', '1.0.0', '1.0.0'
      )
    `;
    await sql`
      INSERT INTO reconciliation_runs (network, market_id, status, detail, projected, observed, source, run_at)
      VALUES (
        'mainnet', ${ZEST_MARKET}, 'match', 'Independent contract read matches projection', '{}', '{}', 'hiro-read', ${NOW}
      )
    `;

    const verifiedRes = await client.earnPerformance({ owner: TEST_OWNER, marketId: ZEST_MARKET });
    const verifiedItem = verifiedRes.data.items.find((i) => i.marketId === ZEST_MARKET);
    assert.ok(verifiedItem);
    assert.equal(verifiedItem.forward30dProjection.isProjectionAvailable, true);
    assert.equal(verifiedItem.forward30dProjection.rateStatus, "verified");
    assert.equal(verifiedItem.forward30dProjection.unavailableReason, null);
    assert.ok(verifiedItem.forward30dProjection.projected30dAmount !== null);

    // Case 2: Stale rate — MUST be null with reason (never 0 or guessed)
    const STALE_MARKET = "granite.sbtc.isolated";
    await sql`
      INSERT INTO market_snapshots (network, market_id, supply_rate, borrow_rate, rate_scale, available_liquidity, capacity, paused, stale, warnings, source, observed_at, block_height, block_hash, adapter_version, calculation_version)
      VALUES (
        'mainnet', ${STALE_MARKET}, 600, null, 4, 1000000000, 5000000000, false, true, '{"Rate is stale"}', 'dia-oracle', ${NOW}, 184000, '0xdef456', '1.0.0', '1.0.0'
      )
    `;

    const staleRes = await client.earnPerformance({ owner: TEST_OWNER, marketId: STALE_MARKET });
    const staleItem = staleRes.data.items.find((i) => i.marketId === STALE_MARKET);
    assert.ok(staleItem);
    assert.equal(staleItem.forward30dProjection.isProjectionAvailable, false);
    assert.equal(staleItem.forward30dProjection.projected30dAmount, null);
    assert.equal(staleItem.forward30dProjection.projected30dUsd, null);
    assert.equal(staleItem.forward30dProjection.rateStatus, "stale");
    assert.match(staleItem.forward30dProjection.unavailableReason!, /current rate is stale/);

    // Case 3: Disputed rate (reconciliation mismatch with independent node read) — MUST be null with reason
    await sql`
      INSERT INTO reconciliation_runs (network, market_id, status, detail, projected, observed, source, run_at)
      VALUES (
        'mainnet', ${STALE_MARKET}, 'mismatch', 'Independent node returned 300 bps vs projected 600 bps', '{"rate": 600}', '{"rate": 300}', 'hiro-read', ${NOW}
      )
    `;

    const disputedRes = await client.earnPerformance({ owner: TEST_OWNER, marketId: STALE_MARKET });
    const disputedItem = disputedRes.data.items.find((i) => i.marketId === STALE_MARKET);
    assert.ok(disputedItem);
    assert.equal(disputedItem.forward30dProjection.isProjectionAvailable, false);
    assert.equal(disputedItem.forward30dProjection.projected30dAmount, null);
    assert.equal(disputedItem.forward30dProjection.rateStatus, "stale"); // stale takes precedence or disputed
  });

  it("Acceptance Evidence 3: History charts use two or more canonical observations and never synthetic points", async () => {
    // 1. Test single observation: hasChart MUST be false, points MUST be empty array
    const SINGLE_OBS_OWNER = "SP2SINGLE_OBSERVATION_USER";
    const OBS_TIME_1 = new Date("2026-09-01T00:00:00.000Z");

    const [zestDep] = await sql<{ id: string }[]>`
      SELECT id FROM deployments WHERE network = 'mainnet' AND protocol_id = 'zest' LIMIT 1
    `;
    assert.ok(zestDep);
    const ZEST_DEPLOYMENT = zestDep.id;

    await sql`
      INSERT INTO position_snapshots (owner, network, deployment_id, market_id, kind, protocol_key, asset_id, quantity, stale, warnings, source, observed_at, block_height, block_hash, adapter_version, calculation_version)
      VALUES (
        ${SINGLE_OBS_OWNER}, 'mainnet', ${ZEST_DEPLOYMENT}, ${ZEST_MARKET}, 'supplied', 'primary', ${SBTC_ASSET},
        100000000, false, '{}', 'hiro-read', ${OBS_TIME_1}, 180000, '0xblock180000', '1.0.0', '1.0.0'
      )
    `;

    const resSingle = await client.earnPerformance({ owner: SINGLE_OBS_OWNER, marketId: ZEST_MARKET });
    const singleItem = resSingle.data.items.find((i) => i.marketId === ZEST_MARKET);
    assert.ok(singleItem);
    assert.equal(singleItem.chart.hasChart, false);
    assert.deepEqual(singleItem.chart.points, []); // Strictly empty array!
    assert.equal(singleItem.chart.observationCount, 1);
    assert.match(singleItem.chart.reason!, /require two or more canonical observations and never synthetic points/);

    // 2. Add second observation: hasChart becomes true, 2 canonical points present
    const OBS_TIME_2 = new Date("2026-09-15T00:00:00.000Z");
    await sql`
      INSERT INTO position_snapshots (owner, network, deployment_id, market_id, kind, protocol_key, asset_id, quantity, stale, warnings, source, observed_at, block_height, block_hash, adapter_version, calculation_version)
      VALUES (
        ${SINGLE_OBS_OWNER}, 'mainnet', ${ZEST_DEPLOYMENT}, ${ZEST_MARKET}, 'supplied', 'primary', ${SBTC_ASSET},
        103000000, false, '{}', 'hiro-read', ${OBS_TIME_2}, 182000, '0xblock182000', '1.0.0', '1.0.0'
      )
    `;

    const resDouble = await client.earnPerformance({ owner: SINGLE_OBS_OWNER, marketId: ZEST_MARKET });
    const doubleItem = resDouble.data.items.find((i) => i.marketId === ZEST_MARKET);
    assert.ok(doubleItem);
    assert.equal(doubleItem.chart.hasChart, true);
    assert.equal(doubleItem.chart.observationCount, 2);
    assert.equal(doubleItem.chart.points.length, 2);
    assert.equal(doubleItem.chart.reason, null);

    // Verified canonical provenance
    assert.equal(doubleItem.chart.points[0]!.source, "hiro-read");
    assert.equal(doubleItem.chart.points[0]!.blockHeight, 180000);
    assert.equal(doubleItem.chart.points[0]!.blockHash, "0xblock180000");

    assert.equal(doubleItem.chart.points[1]!.source, "hiro-read");
    assert.equal(doubleItem.chart.points[1]!.blockHeight, 182000);
    assert.equal(doubleItem.chart.points[1]!.blockHash, "0xblock182000");
  });
});
