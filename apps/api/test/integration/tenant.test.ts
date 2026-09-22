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
import { type ApiScope, connect, createApiKey, MIGRATIONS_DIR, migrate, type Sql } from "@stacks-capital/database";
import { FIXTURE_APP, FIXTURE_WORKFLOW_ID, OTHER_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter, redisClient, redisLimiter } from "../../src/rateLimit.ts";
import { ChallengeResponse, ErrorBody, SessionResponse, WorkflowResponse } from "../../src/schemas.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const REDIS_URL = process.env.REDIS_URL ?? "";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const browser = (app: { clientId: string; origin: string }) => ({
  "x-capital-client-id": app.clientId,
  origin: app.origin,
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("tenant access", { skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false }, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let app: ReturnType<typeof createApp>;

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);
    app = createApp({ sql, limiter: memoryLimiter(), now: () => NOW });
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const key = async (appId: string, scopes: ApiScope[]) => (await createApiKey(sql, { appId, scopes })).token;

  async function call(path: string, headers: Record<string, string>, body?: unknown) {
    const init: RequestInit =
      body === undefined
        ? { headers }
        : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = await app.request(path, init);
    return { response, body: (await response.json()) as unknown };
  }

  async function expectError(
    path: string,
    headers: Record<string, string>,
    status: number,
    code: string,
    body?: unknown,
  ) {
    const result = await call(path, headers, body);
    assert.equal(result.response.status, status);
    assert.equal(ErrorBody.parse(result.body).error.code, code);
    return result.response;
  }

  async function signIn(network: "mainnet" | "testnet") {
    const privateKey = randomPrivateKey();
    const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
    const address = getAddressFromPublicKey(publicKey, network);
    const challenge = await call("/v1/auth/challenge", browser(FIXTURE_APP), { network, address });
    assert.equal(challenge.response.status, 200);
    const { nonceId, message } = ChallengeResponse.parse(challenge.body).data;
    const messageHash = Buffer.from(hashMessage(message)).toString("hex");
    const proof = { network, nonceId, publicKey, signature: signMessageHashRsv({ messageHash, privateKey }) };
    return { address, proof };
  }

  describe("browser apps", () => {
    it("read markets with a client id from an allowed origin and get CORS headers", async () => {
      const { response } = await call("/v1/markets?network=mainnet", browser(FIXTURE_APP));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), FIXTURE_APP.origin);
      assert.equal(response.headers.get("ratelimit-limit"), "60");
    });

    it("are refused from an origin their app does not allow", async () => {
      const headers = { ...browser(FIXTURE_APP), origin: OTHER_APP.origin };
      await expectError("/v1/markets?network=mainnet", headers, 403, "FORBIDDEN");
      const unknown = { origin: "https://unknown.example", "x-capital-client-id": FIXTURE_APP.clientId };
      const response = await expectError("/v1/markets?network=mainnet", unknown, 403, "FORBIDDEN");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    });

    it("are refused with an unknown client id", async () => {
      const headers = { ...browser(FIXTURE_APP), "x-capital-client-id": "pk_nobody" };
      await expectError("/v1/markets?network=mainnet", headers, 401, "UNAUTHORIZED");
    });

    it("answer CORS preflight only for allowed origins", async () => {
      const preflight = (origin: string) =>
        app.request("/v1/markets", {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "GET" },
        });
      assert.equal(
        (await preflight(FIXTURE_APP.origin)).headers.get("access-control-allow-origin"),
        FIXTURE_APP.origin,
      );
      assert.equal((await preflight("https://unknown.example")).headers.get("access-control-allow-origin"), null);
    });

    it("cannot read workflows", async () => {
      await expectError(`/v1/workflows/${FIXTURE_WORKFLOW_ID}?network=mainnet`, browser(FIXTURE_APP), 403, "FORBIDDEN");
    });
  });

  describe("API keys", () => {
    it("are refused when sent from a browser", async () => {
      const headers = { ...bearer(await key(FIXTURE_APP.id, ["markets:read"])), origin: FIXTURE_APP.origin };
      await expectError("/v1/markets?network=mainnet", headers, 403, "FORBIDDEN");
    });

    it("need the scope of the route", async () => {
      const headers = bearer(await key(FIXTURE_APP.id, ["workflows:write"]));
      await expectError("/v1/markets?network=mainnet", headers, 403, "FORBIDDEN");
      const readOnly = bearer(await key(FIXTURE_APP.id, ["markets:read"]));
      await expectError(`/v1/workflows/${FIXTURE_WORKFLOW_ID}?network=mainnet`, readOnly, 403, "FORBIDDEN");
    });

    it("cannot start a wallet sign in", async () => {
      const headers = bearer(await key(FIXTURE_APP.id, ["markets:read"]));
      const body = { network: "mainnet", address: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR" };
      await expectError("/v1/auth/challenge", headers, 403, "FORBIDDEN", body);
    });
  });

  describe("workflow reads", () => {
    it("return the workflow to a key of the owning app", async () => {
      const headers = bearer(await key(FIXTURE_APP.id, ["workflows:write"]));
      const { response, body } = await call(`/v1/workflows/${FIXTURE_WORKFLOW_ID}?network=mainnet`, headers);
      assert.equal(response.status, 200);
      const workflow = WorkflowResponse.parse(body).data;
      assert.equal(workflow.id, FIXTURE_WORKFLOW_ID);
      assert.ok(workflow.transitions.length > 0);
    });

    it("answer 404 to another tenant, exactly as for a missing workflow", async () => {
      const headers = bearer(await key(OTHER_APP.id, ["workflows:write"]));
      const foreign = await call(`/v1/workflows/${FIXTURE_WORKFLOW_ID}?network=mainnet`, headers);
      const missing = await call("/v1/workflows/wf_does_not_exist?network=mainnet", headers);
      assert.equal(foreign.response.status, 404);
      assert.deepEqual(ErrorBody.parse(foreign.body).error, ErrorBody.parse(missing.body).error);
    });

    it("reject a network that does not match the workflow", async () => {
      const headers = bearer(await key(FIXTURE_APP.id, ["workflows:write"]));
      await expectError(`/v1/workflows/${FIXTURE_WORKFLOW_ID}?network=testnet`, headers, 400, "NETWORK_MISMATCH");
    });
  });

  describe("wallet sessions", () => {
    it("sign in with a wallet signature and read only the signer's workflows", async () => {
      const { address, proof } = await signIn("mainnet");
      const verified = await call("/v1/auth/verify", browser(FIXTURE_APP), proof);
      assert.equal(verified.response.status, 200);
      assert.equal(verified.response.headers.get("cache-control"), "no-store");
      const session = SessionResponse.parse(verified.body).data;
      assert.equal(session.address, address);

      await sql`
        INSERT INTO workflows (id, network, idempotency_key, state, next_action, app_id, owner_address)
        SELECT 'wf_session_owned', network, 'idem_session_owned', state, next_action, app_id, ${address}
        FROM workflows WHERE id = ${FIXTURE_WORKFLOW_ID}
      `;
      const headers = { ...bearer(session.token), origin: FIXTURE_APP.origin };
      const owned = await call("/v1/workflows/wf_session_owned?network=mainnet", headers);
      assert.equal(owned.response.status, 200);
      assert.equal(WorkflowResponse.parse(owned.body).data.ownerAddress, address);
      await expectError(`/v1/workflows/${FIXTURE_WORKFLOW_ID}?network=mainnet`, headers, 404, "NOT_FOUND");
      await expectError("/v1/workflows/wf_session_owned?network=testnet", headers, 400, "NETWORK_MISMATCH");
      assert.equal((await call("/v1/markets?network=mainnet", headers)).response.status, 200);
    });

    it("use each challenge once", async () => {
      const { proof } = await signIn("testnet");
      assert.equal((await call("/v1/auth/verify", browser(FIXTURE_APP), proof)).response.status, 200);
      await expectError("/v1/auth/verify", browser(FIXTURE_APP), 401, "UNAUTHORIZED", proof);
    });

    it("burn a challenge on a bad signature", async () => {
      const { proof } = await signIn("testnet");
      const other = await signIn("testnet");
      const forged = { ...proof, signature: other.proof.signature };
      await expectError("/v1/auth/verify", browser(FIXTURE_APP), 401, "UNAUTHORIZED", forged);
      await expectError("/v1/auth/verify", browser(FIXTURE_APP), 401, "UNAUTHORIZED", proof);
    });

    it("refuse a challenge completed by another app or on another network", async () => {
      const first = await signIn("testnet");
      await expectError("/v1/auth/verify", browser(OTHER_APP), 401, "UNAUTHORIZED", first.proof);
      const second = await signIn("testnet");
      await expectError("/v1/auth/verify", browser(FIXTURE_APP), 401, "UNAUTHORIZED", {
        ...second.proof,
        network: "mainnet",
      });
    });

    it("refuse a challenge for an address from another network", async () => {
      const body = { network: "mainnet", address: "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0" };
      await expectError("/v1/auth/challenge", browser(FIXTURE_APP), 400, "NETWORK_MISMATCH", body);
    });
  });

  describe("rate limits", () => {
    it("answer 429 with retry headers once a caller uses its window", async () => {
      const limited = createApp({
        sql,
        limiter: memoryLimiter(),
        limits: { key: 2, session: 2, client: 2, windowSeconds: 60 },
        now: () => NOW,
      });
      const headers = bearer(await key(FIXTURE_APP.id, ["markets:read"]));
      for (const remaining of ["1", "0"]) {
        const response = await limited.request("/v1/markets?network=mainnet", { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("ratelimit-remaining"), remaining);
      }
      const response = await limited.request("/v1/markets?network=mainnet", { headers });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "60");
      const body = ErrorBody.parse(await response.json());
      assert.deepEqual(body.error, {
        code: "RATE_LIMITED",
        message: "Too many requests",
        retryAfter: 60,
        action: "Wait for the number of seconds in retryAfter.",
      });

      const fresh = bearer(await key(FIXTURE_APP.id, ["markets:read"]));
      assert.equal((await limited.request("/v1/markets?network=mainnet", { headers: fresh })).status, 200);
    });
  });
});

describe("Redis limiter", { skip: REDIS_URL === "" ? "REDIS_URL is not set" : false }, () => {
  const client = redisClient(REDIS_URL);
  const prefix = `test:${randomBytes(6).toString("hex")}`;

  before(() => client.connect());
  after(async () => {
    for (const found of await client.keys(`${prefix}:*`)) await client.del(found);
    await client.close();
  });

  it("shares one counter per bucket and window and expires it", async () => {
    const limiter = redisLimiter(client, prefix);
    assert.deepEqual(await limiter.hit("key:a", 2, 60, NOW), {
      allowed: true,
      limit: 2,
      remaining: 1,
      resetSeconds: 60,
    });
    assert.equal((await limiter.hit("key:a", 2, 60, NOW)).allowed, true);
    assert.equal((await limiter.hit("key:a", 2, 60, NOW)).allowed, false);
    const [counter] = await client.keys(`${prefix}:key:a:*`);
    assert.ok(counter !== undefined);
    const ttl = await client.ttl(counter);
    assert.ok(ttl > 0 && ttl <= 60);
  });
});
