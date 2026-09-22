import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createClient } from "@stacks-capital/client";
import {
  connect,
  createApiKey,
  MIGRATIONS_DIR,
  migrate,
  type Sql,
  signWebhookPayload,
  verifyWebhookSignature,
  recordWebhookDelivery,
  processWebhookDeliveryAttempt,
} from "@stacks-capital/database";
import { FIXTURE_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { MAINNET_READS } from "@stacks-capital/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter } from "../../src/rateLimit.ts";
import { ErrorBody } from "../../src/schemas.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const NOW = new Date("2026-09-22T00:00:00.000Z");

describe("Versioned API, Authentication and Webhook Surface (I28)", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_i28_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let app: ReturnType<typeof createApp>;
  let clientA: ReturnType<typeof createClient>;
  let clientRestricted: ReturnType<typeof createClient>;
  let clientB: ReturnType<typeof createClient>;
  let apiKeyA: string;
  let apiKeyRestricted: string;
  let apiKeyB: string;
  let tenantBAppId: string;

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

    // Tenant A - full scopes
    const keyA = await createApiKey(sql, {
      appId: FIXTURE_APP.id,
      scopes: ["markets:read", "positions:read", "quotes:write", "workflows:write", "webhooks:manage"],
    });
    apiKeyA = keyA.token;

    // Tenant A - restricted scopes (missing webhooks:manage)
    const keyRestricted = await createApiKey(sql, {
      appId: FIXTURE_APP.id,
      scopes: ["markets:read"],
    });
    apiKeyRestricted = keyRestricted.token;

    // Tenant B - distinct partner app
    const partnerId = `partner_${randomBytes(4).toString("hex")}`;
    tenantBAppId = `app_${randomBytes(4).toString("hex")}`;
    await sql`INSERT INTO partners (id, name) VALUES (${partnerId}, 'Partner B')`;
    await sql`
      INSERT INTO partner_apps (id, partner_id, name, environment, client_id)
      VALUES (${tenantBAppId}, ${partnerId}, 'Partner B App', 'sandbox', ${`pk_b_${randomBytes(4).toString("hex")}`})
    `;

    const keyB = await createApiKey(sql, {
      appId: tenantBAppId,
      scopes: ["markets:read", "positions:read", "quotes:write", "workflows:write", "webhooks:manage"],
    });
    apiKeyB = keyB.token;

    const makeFetch = () =>
      (async (input: unknown, init?: RequestInit) => {
        const path = typeof input === "string" ? input.replace("http://localhost:3000", "") : "";
        return app.request(path, init);
      }) as typeof fetch;

    clientA = createClient({
      network: "mainnet",
      baseUrl: "http://localhost:3000",
      apiKey: apiKeyA,
      fetch: makeFetch(),
    });

    clientRestricted = createClient({
      network: "mainnet",
      baseUrl: "http://localhost:3000",
      apiKey: apiKeyRestricted,
      fetch: makeFetch(),
    });

    clientB = createClient({
      network: "mainnet",
      baseUrl: "http://localhost:3000",
      apiKey: apiKeyB,
      fetch: makeFetch(),
    });
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  describe("Evidence 1: Runtime schemas and OpenAPI agree", () => {
    it("serves OpenAPI 3.1.0 document declaring all versioned routes including webhooks", async () => {
      const response = await app.request("/v1/openapi.json");
      assert.equal(response.status, 200);

      const doc = (await response.json()) as {
        openapi: string;
        info: { title: string; version: string };
        paths: Record<string, Record<string, unknown>>;
      };

      assert.equal(doc.openapi, "3.1.0");
      assert.equal(doc.info.version, "1.0");

      // Verify webhook paths exist
      assert.ok(doc.paths["/v1/webhooks/endpoints"]);
      assert.ok(doc.paths["/v1/webhooks/endpoints"]?.post);
      assert.ok(doc.paths["/v1/webhooks/endpoints"]?.get);
      assert.ok(doc.paths["/v1/webhooks/endpoints/{id}"]);
      assert.ok(doc.paths["/v1/webhooks/endpoints/{id}"]?.delete);

      // Verify core routes are under /v1/*
      assert.ok(doc.paths["/v1/capabilities"]);
      assert.ok(doc.paths["/v1/markets"]);
      assert.ok(doc.paths["/v1/positions"]);
      assert.ok(doc.paths["/v1/quotes"]);
      assert.ok(doc.paths["/v1/plans"]);
      assert.ok(doc.paths["/v1/workflows"]);
    });
  });

  describe("Evidence 2: Problem responses are typed and actionable", () => {
    it("returns actionable guidance on 401 UNAUTHORIZED", async () => {
      const res = await app.request("/v1/webhooks/endpoints", { method: "GET" });
      assert.equal(res.status, 401);

      const parsed = ErrorBody.parse(await res.json());
      assert.equal(parsed.schemaVersion, "1.0");
      assert.equal(parsed.error.code, "UNAUTHORIZED");
      assert.match(parsed.error.message, /Credentials are required/);
      assert.ok(parsed.error.action);
      assert.match(parsed.error.action, /Sign in again for a session, or check the API key/);
    });

    it("returns actionable guidance on 403 FORBIDDEN when missing webhooks:manage scope", async () => {
      const res = await app.request("/v1/webhooks/endpoints", {
        method: "GET",
        headers: { authorization: `Bearer ${apiKeyRestricted}` },
      });
      assert.equal(res.status, 403);

      const parsed = ErrorBody.parse(await res.json());
      assert.equal(parsed.error.code, "FORBIDDEN");
      assert.match(parsed.error.message, /webhooks:manage/);
      assert.ok(parsed.error.action);
      assert.match(parsed.error.action, /Use a caller with the right scope/);
    });

    it("returns actionable guidance on 400 INVALID_REQUEST for malformed webhook registration", async () => {
      const res = await app.request("/v1/webhooks/endpoints", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKeyA}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "not-a-url", events: [] }),
      });
      assert.equal(res.status, 400);

      const parsed = ErrorBody.parse(await res.json());
      assert.equal(parsed.error.code, "INVALID_REQUEST");
      assert.ok(parsed.error.action);
      assert.match(parsed.error.action, /Fix the request/);
    });
  });

  describe("Evidence 3: Webhook retry and deduplication are demonstrated", () => {
    let createdEndpointId = "";
    let webhookSecret = "";

    it("creates webhook endpoint and returns plaintext secret once", async () => {
      const result = await clientA.createWebhookEndpoint({
        url: "https://partner-a.example.com/webhooks",
        events: ["workflow.completed", "market.updated"],
      });

      assert.ok(result.data.id.startsWith("whe_"));
      assert.equal(result.data.url, "https://partner-a.example.com/webhooks");
      assert.deepEqual(result.data.events, ["workflow.completed", "market.updated"]);
      assert.equal(result.data.active, true);
      assert.ok(result.data.secret?.startsWith("whsec_"));

      createdEndpointId = result.data.id;
      webhookSecret = result.data.secret!;
    });

    it("lists endpoints without leaking plaintext secret", async () => {
      const result = await clientA.webhookEndpoints();
      assert.equal(result.data.items.length, 1);
      const ep = result.data.items[0]!;
      assert.equal(ep.id, createdEndpointId);
      assert.equal(ep.secret, undefined);
    });

    it("enforces tenant isolation across webhook endpoints", async () => {
      // Tenant B listing endpoints sees 0
      const bList = await clientB.webhookEndpoints();
      assert.equal(bList.data.items.length, 0);

      // Tenant B attempting to delete Tenant A's endpoint receives 404
      const res = await app.request(`/v1/webhooks/endpoints/${createdEndpointId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKeyB}` },
      });
      assert.equal(res.status, 404);
    });

    it("verifies HMAC-SHA256 signatures with timestamp tolerance window", () => {
      const payload = JSON.stringify({ event: "workflow.completed", workflowId: "wf_test_1" });
      const currentSeconds = Math.floor(Date.now() / 1000);

      const { header } = signWebhookPayload(payload, webhookSecret, currentSeconds);
      assert.match(header, /^t=\d+,v1=[a-f0-9]{64}$/);

      // Valid signature verifies
      const valid = verifyWebhookSignature(payload, header, webhookSecret, 300, currentSeconds);
      assert.equal(valid.valid, true);

      // Tampered payload fails
      const tampered = verifyWebhookSignature(payload + "tamper", header, webhookSecret, 300, currentSeconds);
      assert.equal(tampered.valid, false);
      assert.equal(tampered.reason, "Signature mismatch");

      // Wrong secret fails
      const wrongSecret = verifyWebhookSignature(payload, header, "whsec_wrong_secret", 300, currentSeconds);
      assert.equal(wrongSecret.valid, false);
      assert.equal(wrongSecret.reason, "Signature mismatch");

      // Expired timestamp outside tolerance window fails
      const expired = verifyWebhookSignature(payload, header, webhookSecret, 300, currentSeconds + 400);
      assert.equal(expired.valid, false);
      assert.equal(expired.reason, "Webhook timestamp expired or outside tolerance window");
    });

    it("deduplicates deliveries using database constraint on (endpoint_id, event_id)", async () => {
      const eventId = `evt_${randomBytes(8).toString("hex")}`;
      const payload = { event: "workflow.completed", id: "wf_xyz" };

      // First recording succeeds
      const first = await recordWebhookDelivery(sql, {
        appId: FIXTURE_APP.id,
        endpointId: createdEndpointId,
        eventId,
        eventType: "workflow.completed",
        payload,
      });
      assert.equal(first.isDuplicate, false);
      assert.ok(first.deliveryId.startsWith("whd_"));
      assert.equal(first.status, "pending");

      // Second recording with identical (endpoint_id, event_id) is marked duplicate
      const second = await recordWebhookDelivery(sql, {
        appId: FIXTURE_APP.id,
        endpointId: createdEndpointId,
        eventId,
        eventType: "workflow.completed",
        payload,
      });
      assert.equal(second.isDuplicate, true);
      assert.equal(second.deliveryId, first.deliveryId);
    });

    it("demonstrates exponential backoff retry scheduling and abandonment at max attempts", async () => {
      const eventId = `evt_retry_${randomBytes(8).toString("hex")}`;
      const rec = await recordWebhookDelivery(sql, {
        appId: FIXTURE_APP.id,
        endpointId: createdEndpointId,
        eventId,
        eventType: "workflow.completed",
        payload: { test: true },
      });

      const baseNow = new Date("2026-09-22T01:00:00.000Z");
      await sql`UPDATE webhook_deliveries SET max_attempts = 3 WHERE id = ${rec.deliveryId}`;

      // Attempt 1: fails with 500 error -> scheduled retry with exponential backoff (2^1 * 1000 = 2000ms)
      const att1 = await processWebhookDeliveryAttempt(
        sql,
        rec.deliveryId,
        { status: "failed", responseStatus: 500, error: "Internal Server Error" },
        baseNow,
      );
      assert.equal(att1.status, "pending");
      assert.equal(att1.attempts, 1);
      assert.ok(att1.nextRetryAt !== null);
      assert.equal(att1.nextRetryAt.getTime(), baseNow.getTime() + 2000);

      // Attempt 2: fails -> scheduled retry (2^2 * 1000 = 4000ms)
      const att2 = await processWebhookDeliveryAttempt(
        sql,
        rec.deliveryId,
        { status: "failed", responseStatus: 502, error: "Bad Gateway" },
        baseNow,
      );
      assert.equal(att2.status, "pending");
      assert.equal(att2.attempts, 2);
      assert.ok(att2.nextRetryAt !== null);
      assert.equal(att2.nextRetryAt.getTime(), baseNow.getTime() + 4000);

      // Attempt 3 (reaches maxAttempts = 3): abandoned
      const att3 = await processWebhookDeliveryAttempt(
        sql,
        rec.deliveryId,
        { status: "failed", responseStatus: 503, error: "Service Unavailable" },
        baseNow,
      );
      assert.equal(att3.status, "abandoned");
      assert.equal(att3.attempts, 3);
      assert.equal(att3.nextRetryAt, null);
    });

    it("deactivates webhook endpoint and returns 404 on subsequent deletion", async () => {
      const del = await clientA.deleteWebhookEndpoint(createdEndpointId);
      assert.equal(del.data.deleted, true);

      // Listing now returns empty
      const list = await clientA.webhookEndpoints();
      assert.equal(list.data.items.length, 0);

      // Second delete returns 404
      const secondRes = await app.request(`/v1/webhooks/endpoints/${createdEndpointId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKeyA}` },
      });
      assert.equal(secondRes.status, 404);
    });
  });
});
