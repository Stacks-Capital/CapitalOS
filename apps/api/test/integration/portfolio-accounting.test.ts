import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createClient } from "@stacks-capital/client";
import {
  connect,
  createApiKey,
  latestPriceValuations,
  latestPositions,
  latestWalletBalances,
  MIGRATIONS_DIR,
  migrate,
  type Sql,
} from "@stacks-capital/database";
import { FIXTURE_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { MAINNET_READS, GOLDEN_FIXTURE_OWNER, reconcileGoldenPortfolioAccounting } from "@stacks-capital/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter } from "../../src/rateLimit.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const NOW = new Date("2026-09-22T00:00:00.000Z");

describe("Canonical Portfolio and Debt Accounting (I26)", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_i26_${randomBytes(6).toString("hex")}`;
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

  it("Acceptance Evidence 1: Golden addresses reconcile against explorer and protocol reads", async () => {
    const reports = reconcileGoldenPortfolioAccounting();
    assert.ok(reports.length > 0);
    const goldenUser = reports.find((r) => r.address === GOLDEN_FIXTURE_OWNER);
    assert.ok(goldenUser);
    assert.equal(goldenUser.matched, true);
    assert.equal(goldenUser.explorerBalanceMatched, true);
    assert.equal(goldenUser.protocolPositionsMatched, true);
    assert.equal(goldenUser.linkedCollateralMatched, true);
    assert.equal(goldenUser.exactNetMatched, true);
  });

  it("Acceptance Evidence 2: Assets minus debt equals displayed net subtotal exactly", async () => {
    const userAddress = "SP1P72Z3704VMT3DMHPP2CB8TGQWGDBHD3RPR9GZS";

    // 1. Seed prices: BTC @ $60,000, STX @ $2.00, USDC @ $1.00
    await sql`
      INSERT INTO price_snapshots (network, feed_key, price, price_scale, published_at, stale, warnings, source, observed_at)
      VALUES
        ('mainnet', 'BTC/USD', 6000000000000, 8, ${NOW}, false, '{}', 'dia-oracle', ${NOW}),
        ('mainnet', 'STX/USD', 200000000, 8, ${NOW}, false, '{}', 'dia-oracle', ${NOW}),
        ('mainnet', 'USDC/USD', 100000000, 8, ${NOW}, false, '{}', 'dia-oracle', ${NOW})
    `;

    const SBTC_ASSET = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
    const USDC_ASSET = "stacks:mainnet:contract:SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx:usdcx-token";
    const GRANITE_DEPLOYMENT = "granite:mainnet:SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market@8883545";

    // 2. Seed wallet balance: 1,000 STX = $2,000 USD (scale 6: 1000000000)
    await sql`
      INSERT INTO wallet_balance_snapshots (network, address, asset_id, quantity, stale, warnings, source, observed_at)
      VALUES ('mainnet', ${userAddress}, 'stacks:mainnet:native:stx', 1000000000, false, '{}', 'hiro-explorer', ${NOW})
    `;

    // 3. Seed protocol positions:
    // Collateral: 2 sBTC ($120,000 USD)
    // Debt: 50,000 USDC ($50,000 USD)
    await sql`
      INSERT INTO position_snapshots (owner, network, deployment_id, market_id, kind, protocol_key, asset_id, quantity, stale, warnings, source, observed_at, adapter_version, calculation_version)
      VALUES
        (${userAddress}, 'mainnet', ${GRANITE_DEPLOYMENT}, 'granite.sbtc.isolated', 'collateral', 'granite.sbtc.isolated:collateral', ${SBTC_ASSET}, 200000000, false, '{}', 'hiro-read', ${NOW}, 'granite@1.0.0', 'pos@1.0.0'),
        (${userAddress}, 'mainnet', ${GRANITE_DEPLOYMENT}, 'granite.sbtc.isolated', 'debt', 'granite.sbtc.isolated:debt', ${USDC_ASSET}, 50000000000, false, '{}', 'hiro-read', ${NOW}, 'granite@1.0.0', 'pos@1.0.0')
    `;

    // 4. Query /v1/portfolio
    const response = await app.request(`/v1/portfolio?network=mainnet&owner=${userAddress}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: {
        grossAssetsUsd: string;
        grossDebtUsd: string;
        netWorthUsd: string;
        coverage: { isComplete: boolean; valuedCount: number };
        entries: Array<{ category: string; assetId: string; quantity: string; linkedCollateral: unknown }>;
        byCategory: Record<string, { totalUsd: string; count: number }>;
      };
    };

    // Gross Assets: 2 BTC ($120,000) + 1000 STX ($2,000) = $122,000 USD = 12200000000000
    assert.equal(body.data.grossAssetsUsd, "12200000000000");

    // Gross Debt: 50,000 USDC = $50,000 USD = 5000000000000
    assert.equal(body.data.grossDebtUsd, "5000000000000");

    // Exact Net: 122,000 - 50,000 = $72,000 USD = 7200000000000
    assert.equal(body.data.netWorthUsd, "7200000000000");

    // Math invariant:
    assert.equal(
      BigInt(body.data.netWorthUsd) === BigInt(body.data.grossAssetsUsd) - BigInt(body.data.grossDebtUsd),
      true,
    );

    // Complete coverage
    assert.equal(body.data.coverage.isComplete, true);
    assert.equal(body.data.coverage.valuedCount, 3);

    // Category summaries
    assert.equal(body.data.byCategory.wallet?.totalUsd, "200000000000");
    assert.equal(body.data.byCategory.collateral?.totalUsd, "12000000000000");
    assert.equal(body.data.byCategory.debt?.totalUsd, "5000000000000");
  });

  it("Acceptance Evidence 3: Borrowed token is visibly linked to its collateral position", async () => {
    const userAddress = "SP1P72Z3704VMT3DMHPP2CB8TGQWGDBHD3RPR9GZS";

    // 1. Positions endpoint returns linkedCollateral on debt
    const posRes = await app.request(`/v1/positions?network=mainnet&owner=${userAddress}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(posRes.status, 200);
    const posBody = (await posRes.json()) as {
      data: {
        items: Array<{
          kind: string;
          marketId: string;
          assetId: string;
          linkedCollateral: { marketId: string; assetId: string; quantity: string | null } | null;
        }>;
      };
    };

    const SBTC_ASSET = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";

    const debtPos = posBody.data.items.find((p) => p.kind === "debt");
    assert.ok(debtPos);
    assert.ok(debtPos.linkedCollateral);
    assert.equal(debtPos.linkedCollateral.marketId, "granite.sbtc.isolated");
    assert.equal(debtPos.linkedCollateral.assetId, SBTC_ASSET);
    assert.equal(debtPos.linkedCollateral.quantity, "200000000");

    // 2. Portfolio endpoint returns linkedCollateral on debt entry
    const portRes = await client.portfolio({ owner: userAddress });
    assert.ok(portRes.data);
    const debtEntry = portRes.data.entries.find((e) => e.category === "debt");
    assert.ok(debtEntry);
    assert.ok(debtEntry.linkedCollateral);
    assert.equal(debtEntry.linkedCollateral.marketId, "granite.sbtc.isolated");
    assert.equal(debtEntry.linkedCollateral.assetId, SBTC_ASSET);
  });

  it("Prevents receipt-token and underlying-claim double counting", async () => {
    const userAddress = "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE";
    const ZEST_SHARES = "stacks:mainnet:contract:SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc:zft";

    // Seed receipt token zft (zsBTC) in wallet for user
    await sql`
      INSERT INTO wallet_balance_snapshots (network, address, asset_id, quantity, stale, warnings, source, observed_at)
      VALUES ('mainnet', ${userAddress}, ${ZEST_SHARES}, 100000000, false, '{}', 'hiro-explorer', ${NOW})
    `;

    const res = await app.request(`/v1/portfolio?network=mainnet&owner=${userAddress}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: {
        entries: Array<{ assetId: string; isReceipt: boolean; countsTowardTotal: boolean }>;
      };
    };

    const receiptEntry = body.data.entries.find((e) => e.assetId === ZEST_SHARES);
    assert.ok(receiptEntry);
    assert.equal(receiptEntry.isReceipt, true);
    assert.equal(receiptEntry.countsTowardTotal, false); // Deduplicated!
  });
});
