import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { hashMessage } from "@stacks/encryption";
import {
  getAddressFromPublicKey,
  privateKeyToPublic,
  publicKeyToHex,
  randomPrivateKey,
  signMessageHashRsv,
} from "@stacks/transactions";
import { CapitalApiError, type CapitalClient, createClient } from "@stacks-capital/client";
import { connect, createApiKey, MIGRATIONS_DIR, migrate, type Sql } from "@stacks-capital/database";
import { FIXTURE_APP, FIXTURE_WORKFLOW_ID, OTHER_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter } from "../../src/rateLimit.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const BASE = "http://api.test";

// The client speaks HTTP, so the app answers real Requests. Only the socket is missing.
function appFetch(app: ReturnType<typeof createApp>, origin?: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (origin !== undefined) headers.set("origin", origin);
    return app.request(String(input).replace(BASE, ""), { ...init, headers });
  }) as typeof fetch;
}

describe("client against the API", { skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false }, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let app: ReturnType<typeof createApp>;
  let browser: CapitalClient;

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);
    app = createApp({ sql, limiter: memoryLimiter(), now: () => new Date("2026-09-18T09:00:00.000Z") });
    browser = createClient({
      baseUrl: BASE,
      network: "mainnet",
      clientId: FIXTURE_APP.clientId,
      fetch: appFetch(app, FIXTURE_APP.origin),
      sleep: async () => {},
    });
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const serverClient = async (appId: string, scopes: Parameters<typeof createApiKey>[1]["scopes"]) => {
    const { token } = await createApiKey(sql, { appId, scopes });
    return createClient({
      baseUrl: BASE,
      network: "mainnet",
      apiKey: token,
      fetch: appFetch(app),
      sleep: async () => {},
    });
  };

  it("reads markets and capabilities through the envelope", async () => {
    const markets = await browser.markets({ limit: 2 });
    assert.equal(markets.items.length, 2);
    assert.equal(markets.context.network, "mainnet");
    assert.match(markets.context.requestId, /^req_/);
    assert.equal(markets.context.stale, false);

    const all = await browser.allMarkets();
    assert.deepEqual(
      all.map((market) => market.id),
      ["bitflow.sbtc-usdcx", "granite.sbtc.isolated", "sbtc.deposit", "sbtc.withdraw", "zest.sbtc.vault"],
    );
    const capabilities = await browser.capabilities({ limit: 3 });
    assert.equal(capabilities.items.length, 3);
    assert.ok(capabilities.items.every((capability) => capability.marketId !== undefined));
  });

  it("signs in with a wallet signature and reads that address's workflow", async () => {
    const privateKey = randomPrivateKey();
    const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
    const address = getAddressFromPublicKey(publicKey, "mainnet");

    const challenge = await browser.challenge({ address });
    assert.match(challenge.data.message, new RegExp(address));
    const messageHash = Buffer.from(hashMessage(challenge.data.message)).toString("hex");
    const verified = await browser.verify({
      nonceId: challenge.data.nonceId,
      publicKey,
      signature: signMessageHashRsv({ messageHash, privateKey }),
    });
    assert.equal(verified.data.address, address);

    await sql`
      INSERT INTO workflows (id, network, idempotency_key, state, next_action, app_id, owner_address)
      SELECT 'wf_client', network, 'idem_client', state, next_action, app_id, ${address}
      FROM workflows WHERE id = ${FIXTURE_WORKFLOW_ID}
    `;
    const signedIn = browser.withSession(verified.data.token);
    const workflow = await signedIn.workflow("wf_client");
    assert.equal(workflow.data.ownerAddress, address);

    // Another address's workflow is not found, exactly as the API reports it.
    await assert.rejects(signedIn.workflow(FIXTURE_WORKFLOW_ID), (error: unknown) => {
      assert.ok(error instanceof CapitalApiError);
      assert.deepEqual([error.code, error.status, error.errorClass], ["NOT_FOUND", 404, "user_action"]);
      return true;
    });
  });

  it("reports a cross tenant read as the same not found", async () => {
    const owner = await serverClient(FIXTURE_APP.id, ["workflows:write"]);
    const other = await serverClient(OTHER_APP.id, ["workflows:write"]);
    assert.equal((await owner.workflow(FIXTURE_WORKFLOW_ID)).data.id, FIXTURE_WORKFLOW_ID);
    await assert.rejects(
      other.workflow(FIXTURE_WORKFLOW_ID),
      (error: unknown) => error instanceof CapitalApiError && error.code === "NOT_FOUND",
    );
  });

  it("surfaces a missing scope and an unknown client id as typed errors", async () => {
    const wrongScope = await serverClient(FIXTURE_APP.id, ["positions:read"]);
    await assert.rejects(
      wrongScope.markets(),
      (error: unknown) => error instanceof CapitalApiError && error.code === "FORBIDDEN" && error.status === 403,
    );

    const unknown = createClient({
      baseUrl: BASE,
      network: "mainnet",
      clientId: "pk_nobody",
      fetch: appFetch(app, FIXTURE_APP.origin),
      sleep: async () => {},
    });
    await assert.rejects(
      unknown.markets(),
      (error: unknown) => error instanceof CapitalApiError && error.code === "UNAUTHORIZED",
    );
  });

  it("reports a rate limit with the wait the API asked for, instead of blocking for a minute", async () => {
    const limited = createApp({
      sql,
      limiter: memoryLimiter(),
      limits: { key: 1, session: 1, client: 1, windowSeconds: 60 },
      now: () => new Date("2026-09-18T09:00:00.000Z"),
    });
    const waits: number[] = [];
    const client = createClient({
      baseUrl: BASE,
      network: "mainnet",
      clientId: FIXTURE_APP.clientId,
      fetch: appFetch(limited, FIXTURE_APP.origin),
      sleep: async (ms) => void waits.push(ms),
      retry: { attempts: 2 },
    });

    assert.equal((await client.markets()).items.length > 0, true);
    await assert.rejects(client.markets(), (error: unknown) => {
      assert.ok(error instanceof CapitalApiError);
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.retryAfter, 60);
      return true;
    });
    // A minute is longer than the client will hold a request open, so it reports rather than waiting.
    assert.deepEqual(waits, []);
  });
});
