import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MIGRATIONS_DIR, type Sql, connect, migrate } from "@stacks-capital/database";
import { seedFixtures } from "@stacks-capital/database/fixtures";
import { getHealthStatus, startHealthServer } from "../../src/health.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

describe("worker health server", { skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false }, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_health_${randomBytes(6).toString("hex")}`;
  let sql: Sql;

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("computes health status with checkpoint, lag, and failure metrics", async () => {
    const health = await getHealthStatus(sql, "mainnet");
    assert.ok(health.status === "ok" || health.status === "degraded" || health.status === "unhealthy");
    assert.equal(health.network, "mainnet");
    assert.ok(health.ingestion.checkpointHeight !== null, "Checkpoint height should be present from seeded fixtures");
    assert.ok(health.ingestion.checkpointHash !== null, "Checkpoint hash should be present");
    assert.ok(health.ingestion.checkpointAt !== null, "Checkpoint timestamp should be present");
    assert.ok(typeof health.ingestion.failuresInWindow === "number");
  });

  it("serves /health, /readyz, and /status endpoints over HTTP", async () => {
    const abort = new AbortController();
    // Use ephemeral port (port 0 lets OS assign free port)
    const server = startHealthServer({
      sql,
      network: "mainnet",
      port: 0,
      signal: abort.signal,
    });

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const port = addr.port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. /health
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as { status: string };
      assert.equal(healthJson.status, "ok");

      // 2. /readyz
      const readyRes = await fetch(`${baseUrl}/readyz`);
      assert.equal(readyRes.status, 200);
      const readyJson = (await readyRes.json()) as { ready: boolean };
      assert.equal(readyJson.ready, true);

      // 3. /status
      const statusRes = await fetch(`${baseUrl}/status`);
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as { ingestion: { checkpointHeight: number | null } };
      assert.ok(statusJson.ingestion.checkpointHeight !== null);

      // 4. Unknown route -> 404
      const notFoundRes = await fetch(`${baseUrl}/unknown`);
      assert.equal(notFoundRes.status, 404);
    } finally {
      abort.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
