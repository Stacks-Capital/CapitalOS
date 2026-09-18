import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { connect, createApiKey, MIGRATIONS_DIR, migrate, type Sql } from "@stacks-capital/database";
import { FIXTURE_APP, OTHER_APP, seedFixtures } from "@stacks-capital/database/fixtures";
import { MAINNET_OWNER, MAINNET_READS } from "@stacks-capital/fixtures";
import { createApp } from "../../src/app.ts";
import { memoryLimiter } from "../../src/rateLimit.ts";
import {
  ErrorBody,
  PositionsResponse,
  QuoteResponse,
  SignatureResponse,
  StartedWorkflowResponse,
} from "../../src/schemas.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
// The fixtures are quoted at this instant, so a quote made here is fresh.
const NOW = new Date("2026-09-15T12:00:00.000Z");
const SUPPLY = { network: "mainnet", marketId: "zest.sbtc.vault", action: "supply", amount: "100000" } as const;

describe("execution", { skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false }, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let app: ReturnType<typeof createApp>;
  let keyHeaders: Record<string, string>;

  const build = (at: Date) =>
    createApp({ sql, limiter: memoryLimiter(), now: () => at, reads: async () => MAINNET_READS });

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);
    app = build(NOW);
    const { token } = await createApiKey(sql, {
      appId: FIXTURE_APP.id,
      scopes: ["quotes:write", "workflows:write", "markets:read", "positions:read"],
    });
    keyHeaders = { authorization: `Bearer ${token}` };
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const post = async (path: string, body: unknown, headers = keyHeaders, on = app) => {
    const response = await on.request(path, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, body: (await response.json()) as unknown };
  };

  const quote = async () => {
    const result = await post("/v1/quotes", { ...SUPPLY, owner: MAINNET_OWNER });
    assert.equal(result.response.status, 200);
    return QuoteResponse.parse(result.body).data;
  };

  it("quotes on the server and stores the quote and its plan", async () => {
    const data = await quote();
    assert.equal(data.quote.marketId, "zest.sbtc.vault");
    assert.equal(data.quote.action, "supply");
    assert.equal(data.quote.executable, true);
    // Quantities cross the wire as strings, never JSON numbers.
    assert.match(data.quote.input[0]?.quantity ?? "", /^[0-9]+$/);
    assert.ok(data.plan.steps.length > 0);
    assert.equal(data.plan.quoteId, data.quote.id);

    const [stored] = await sql<{ id: string; executable: boolean }[]>`
      SELECT id, executable FROM quotes WHERE id = ${data.quote.id}
    `;
    assert.equal(stored?.executable, true);
    const [plan] = await sql<{ id: string }[]>`SELECT id FROM plans WHERE quote_id = ${data.quote.id}`;
    assert.equal(plan?.id, data.plan.id);
  });

  it("starts one workflow per idempotency key", async () => {
    const quoted = await quote();
    const key = `idem_${randomBytes(6).toString("hex")}`;
    const body = { network: "mainnet", quoteId: quoted.quote.id, idempotencyKey: key, ownerAddress: MAINNET_OWNER };

    const first = await post("/v1/workflows", body);
    assert.equal(first.response.status, 200);
    const started = StartedWorkflowResponse.parse(first.body).data;
    assert.equal(started.state, "AWAITING_SIGNATURE");
    assert.equal(started.plan.id, quoted.plan.id);

    const second = await post("/v1/workflows", body);
    assert.equal(StartedWorkflowResponse.parse(second.body).data.workflowId, started.workflowId);
    const [count] = await sql<
      { count: string }[]
    >`SELECT count(*) AS count FROM workflows WHERE idempotency_key = ${key}`;
    assert.equal(Number(count?.count), 1);

    const [steps] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM workflow_steps WHERE workflow_id = ${started.workflowId}
    `;
    assert.equal(Number(steps?.count), quoted.plan.steps.length);
  });

  async function startedWorkflow() {
    const quoted = await quote();
    const started = await post("/v1/workflows", {
      network: "mainnet",
      quoteId: quoted.quote.id,
      idempotencyKey: `idem_${randomBytes(6).toString("hex")}`,
      ownerAddress: MAINNET_OWNER,
    });
    return { quoted, started: StartedWorkflowResponse.parse(started.body).data };
  }

  it("records a broadcast and moves the workflow to submitted", async () => {
    const { started } = await startedWorkflow();
    const stepId = started.plan.steps[0]?.id ?? "";
    const txid = `0x${randomBytes(32).toString("hex")}`;

    const result = await post(`/v1/workflows/${started.workflowId}/signature`, {
      network: "mainnet",
      stepId,
      walletResult: { txid },
    });
    assert.deepEqual(SignatureResponse.parse(result.body).data, {
      state: "SUBMITTED",
      nextAction: "WAIT",
      outcome: "BROADCAST",
      txid,
    });

    const [attempt] = await sql<{ outcome: string; txid: string }[]>`
      SELECT outcome, txid FROM transaction_attempts WHERE workflow_id = ${started.workflowId}
    `;
    assert.deepEqual(attempt, { outcome: "BROADCAST", txid });

    // Reporting the same step again changes nothing.
    const replay = await post(`/v1/workflows/${started.workflowId}/signature`, {
      network: "mainnet",
      stepId,
      walletResult: { txid },
    });
    assert.equal(SignatureResponse.parse(replay.body).data.state, "SUBMITTED");
    const [count] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM transaction_attempts WHERE workflow_id = ${started.workflowId}
    `;
    assert.equal(Number(count?.count), 1);
  });

  it("treats a wallet answer without a txid as an unknown broadcast, never a retry", async () => {
    const { started } = await startedWorkflow();
    const result = await post(`/v1/workflows/${started.workflowId}/signature`, {
      network: "mainnet",
      stepId: started.plan.steps[0]?.id ?? "",
      walletResult: { transaction: "0xsigned-but-not-broadcast" },
    });
    const data = SignatureResponse.parse(result.body).data;
    assert.equal(data.outcome, "SIGNED");
    assert.equal(data.state, "BROADCAST_UNKNOWN");
    assert.equal(data.txid, null);
  });

  it("refuses a quote that has expired instead of executing it", async () => {
    const quoted = await quote();
    const later = build(new Date(new Date(quoted.quote.expiresAt).getTime() + 1000));
    const result = await post(
      "/v1/workflows",
      {
        network: "mainnet",
        quoteId: quoted.quote.id,
        idempotencyKey: `idem_${randomBytes(6).toString("hex")}`,
        ownerAddress: MAINNET_OWNER,
      },
      keyHeaders,
      later,
    );
    // A stale quote is a conflict: ask for a new one, do not retry this.
    assert.equal(result.response.status, 409);
    assert.equal(ErrorBody.parse(result.body).error.code, "QUOTE_EXPIRED");
  });

  it("keeps another tenant out of the workflow", async () => {
    const { started } = await startedWorkflow();
    const { token } = await createApiKey(sql, { appId: OTHER_APP.id, scopes: ["workflows:write"] });
    const result = await post(
      `/v1/workflows/${started.workflowId}/signature`,
      { network: "mainnet", stepId: started.plan.steps[0]?.id ?? "", walletResult: { txid: "0xabc" } },
      { authorization: `Bearer ${token}` },
    );
    assert.equal(result.response.status, 404);
    assert.equal(ErrorBody.parse(result.body).error.code, "NOT_FOUND");
  });

  it("refuses a browser client and a key without the scope", async () => {
    const browser = { "x-capital-client-id": FIXTURE_APP.clientId, origin: FIXTURE_APP.origin };
    const asBrowser = await post("/v1/quotes", { ...SUPPLY, owner: MAINNET_OWNER }, browser);
    assert.equal(asBrowser.response.status, 403);

    const { token } = await createApiKey(sql, { appId: FIXTURE_APP.id, scopes: ["markets:read"] });
    const unscoped = await post(
      "/v1/quotes",
      { ...SUPPLY, owner: MAINNET_OWNER },
      { authorization: `Bearer ${token}` },
    );
    assert.equal(unscoped.response.status, 403);
    assert.equal(ErrorBody.parse(unscoped.body).error.code, "FORBIDDEN");
  });

  it("requires an owner address when an API key starts a workflow", async () => {
    const quoted = await quote();
    const result = await post("/v1/workflows", {
      network: "mainnet",
      quoteId: quoted.quote.id,
      idempotencyKey: `idem_${randomBytes(6).toString("hex")}`,
    });
    assert.equal(result.response.status, 400);
    assert.equal(ErrorBody.parse(result.body).error.code, "INVALID_REQUEST");
  });

  it("serves the positions the worker projected, and refuses a key without an owner", async () => {
    await sql`
      INSERT INTO position_snapshots (owner, network, deployment_id, market_id, kind, protocol_key, asset_id, quantity,
                                      stale, warnings, source, observed_at, adapter_version, calculation_version)
      SELECT ${MAINNET_OWNER}, 'mainnet', c.deployment_id, 'zest.sbtc.vault', 'supplied', 'zest.sbtc.vault:supplied',
             m.supplied_asset_id, 100054938, false, '{}', 'hiro-read', ${new Date(NOW.getTime() + 3_600_000)},
             'zest-earn@0.1.0',
             'position-decoder@0.1.0'
      FROM markets m
      JOIN capabilities c ON c.network = m.network AND c.market_id = m.id AND c.action = 'supply'
      WHERE m.network = 'mainnet' AND m.id = 'zest.sbtc.vault'
    `;

    const response = await app.request(`/v1/positions?network=mainnet&owner=${MAINNET_OWNER}`, {
      headers: { ...keyHeaders, "x-scope": "positions" },
    });
    assert.equal(response.status, 200);
    const body = PositionsResponse.parse(await response.json());
    // The fixtures hold their own position for this market under a different protocol key, and both survive.
    const supplied = body.data.items.find((item) => item.protocolKey === "zest.sbtc.vault:supplied");
    assert.equal(supplied?.quantity, "100054938");
    // The fixtures also hold an unknown position, and unknown stays unknown rather than becoming zero.
    assert.ok(body.data.items.some((item) => item.quantity === null && item.warnings.length > 0));

    const withoutOwner = await app.request("/v1/positions?network=mainnet", { headers: keyHeaders });
    assert.equal(withoutOwner.status, 400);
  });

  it("reports a market it cannot quote without exposing internals", async () => {
    const result = await post("/v1/quotes", { ...SUPPLY, marketId: "nope.market", owner: MAINNET_OWNER });
    assert.equal(result.response.status, 400);
    const error = ErrorBody.parse(result.body).error;
    assert.equal(error.code, "UNSUPPORTED_ACTION");
    assert.doesNotMatch(error.message, /stack|adapter internals/i);
  });
});
