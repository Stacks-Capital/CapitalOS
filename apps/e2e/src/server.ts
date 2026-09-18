import { serve } from "@hono/node-server";
import { createApp } from "@stacks-capital/api/app";
import { memoryLimiter } from "@stacks-capital/api/rate-limit";
import { connect, MIGRATIONS_DIR, migrate, requireDatabaseUrl } from "@stacks-capital/database";
import { seedFixtures } from "@stacks-capital/database/fixtures";
import { MAINNET_READS } from "@stacks-capital/fixtures";

/*
 * The API the browser tests talk to. It is the real app on a fresh, seeded schema, with two
 * differences: market reads come from fixtures, so no test touches a live provider, and rate
 * limits are counted in memory, so no Redis is needed.
 */

const SCHEMA = "e2e";
const port = Number(process.env.E2E_API_PORT ?? "3100");
const url = requireDatabaseUrl(process.env.DATABASE_URL);

const admin = connect(url);
await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`);
await admin.end();

const sql = connect(url, SCHEMA);
await migrate(sql, MIGRATIONS_DIR);
await seedFixtures(sql);

// Fixture reads carry the fixtures' own timestamp. Restamping them keeps quotes fresh at test time.
function freshReads(): typeof MAINNET_READS {
  const now = new Date().toISOString();
  return JSON.parse(JSON.stringify(MAINNET_READS), (key, value) => (key === "observedAt" ? now : value));
}

const app = createApp({
  sql,
  limiter: memoryLimiter(),
  limits: { key: 10_000, session: 10_000, client: 10_000, windowSeconds: 60 },
  reads: async () => freshReads(),
});

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`e2e API on http://127.0.0.1:${info.port} (schema ${SCHEMA})`);
});
