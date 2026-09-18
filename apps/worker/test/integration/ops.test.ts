import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { connect, metricsSnapshot, MIGRATIONS_DIR, migrate, recordOpsEvent, type Sql } from "@stacks-capital/database";
import { FIXTURE_WORKFLOW_ID, seedFixtures } from "@stacks-capital/database/fixtures";
import { evaluateAlerts, reconcileAlerts } from "../../src/alerts.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const AT = new Date("2026-09-18T12:00:00.000Z");
const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

describe("operations", { skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false }, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_${randomBytes(6).toString("hex")}`;
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

  const snapshotAt = (at: Date) => metricsSnapshot(sql, { network: "mainnet", at, windowSeconds: 15 * 60 });

  it("computes lag, quote failures and stuck workflows from what was recorded", async () => {
    await recordOpsEvent(sql, { kind: "ingestion_tick", network: "mainnet", subject: "stacks", value: 45, at: AT });
    for (let index = 0; index < 6; index += 1) {
      await recordOpsEvent(sql, {
        kind: index < 4 ? "quote_failed" : "quote_succeeded",
        network: "mainnet",
        subject: "zest.sbtc.vault",
        code: index < 4 ? "ORACLE_STALE" : null,
        at: AT,
      });
    }

    const snapshot = await snapshotAt(AT);
    assert.equal(snapshot.ingestion.blocksBehind, 45);
    assert.deepEqual(snapshot.quotes, [
      { subject: "zest.sbtc.vault", attempts: 6, failures: 4, codes: { ORACLE_STALE: 4 } },
    ]);
    // The fixture workflow has sat in CONFIRMING since the fixtures were seeded, days before AT.
    assert.ok(snapshot.stuck.some((workflow) => workflow.id === FIXTURE_WORKFLOW_ID));
  });

  it("opens each problem once, however often it is seen, and notifies only on change", async () => {
    const first = await reconcileAlerts(sql, "mainnet", evaluateAlerts(await snapshotAt(AT)), AT);
    const opened = first.notifications.map((notification) => notification.dedupeKey).sort();
    // The fixture checkpoint dates from the seed, days before AT, so ingestion has also stopped.
    assert.deepEqual(opened, [
      "ingestion_failing:mainnet",
      "ingestion_lag:mainnet",
      "quote_failures:mainnet:zest.sbtc.vault",
      `workflow_stuck:mainnet:${FIXTURE_WORKFLOW_ID}`,
    ]);

    // The same problems a minute later: no new rows, no notifications, the count goes up.
    const second = await reconcileAlerts(sql, "mainnet", evaluateAlerts(await snapshotAt(later(1))), later(1));
    assert.deepEqual(second.notifications, []);
    const [lag] = await sql<{ count: number; occurrences: number }[]>`
      SELECT count(*)::int AS count, max(occurrences)::int AS occurrences FROM alerts
      WHERE dedupe_key = 'ingestion_lag:mainnet'
    `;
    assert.deepEqual({ ...lag }, { count: 1, occurrences: 2 });
  });

  it("resolves what has cleared, and opens a fresh alert if it comes back", async () => {
    await recordOpsEvent(sql, {
      kind: "ingestion_tick",
      network: "mainnet",
      subject: "stacks",
      value: 1,
      at: later(2),
    });
    const cleared = await reconcileAlerts(sql, "mainnet", evaluateAlerts(await snapshotAt(later(2))), later(2));
    assert.ok(
      cleared.notifications.some(
        (notification) => notification.event === "resolved" && notification.dedupeKey === "ingestion_lag:mainnet",
      ),
    );

    await recordOpsEvent(sql, {
      kind: "ingestion_tick",
      network: "mainnet",
      subject: "stacks",
      value: 80,
      at: later(3),
    });
    const back = await reconcileAlerts(sql, "mainnet", evaluateAlerts(await snapshotAt(later(3))), later(3));
    assert.ok(
      back.notifications.some(
        (notification) => notification.event === "opened" && notification.dedupeKey === "ingestion_lag:mainnet",
      ),
    );

    const rows = await sql<{ resolved: boolean }[]>`
      SELECT resolved_at IS NOT NULL AS resolved FROM alerts WHERE dedupe_key = 'ingestion_lag:mainnet' ORDER BY id
    `;
    assert.deepEqual(
      rows.map((row) => row.resolved),
      [true, false],
    );
  });

  it("refuses a second open alert for the same key at the database level", async () => {
    await assert.rejects(
      sql`
        INSERT INTO alerts (dedupe_key, kind, severity, network, subject, message, first_seen, last_seen)
        VALUES ('ingestion_lag:mainnet', 'ingestion_lag', 'warning', 'mainnet', 'stacks', 'duplicate', ${AT}, ${AT})
      `,
    );
  });
});
