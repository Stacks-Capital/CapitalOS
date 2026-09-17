import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import {
  countRows,
  FIXTURE_IDEMPOTENCY_KEY,
  FIXTURE_WORKFLOW_ID,
  FIXTURE_ZEST_SUPPLY,
  seedFixtures,
  TABLES,
} from "./fixtures.ts";
import { connect, loadMigrations, migrate, type Sql } from "./lib.ts";

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const UNIQUE = "23505";
const CHECK = "23514";
const FOREIGN_KEY = "23503";
const APPEND_ONLY = "23001";

function withCode(code: string) {
  return (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("database", { skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false }, () => {
  const admin = connect(DATABASE_URL);
  const opened: { sql: Sql; schema: string }[] = [];
  const folders: string[] = [];

  // Each test gets its own schema, so tests never share or leave behind state.
  async function freshSchema(migrated: boolean): Promise<Sql> {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const sql = connect(DATABASE_URL, schema);
    opened.push({ sql, schema });
    if (migrated) await migrate(sql, MIGRATIONS);
    return sql;
  }

  async function digest(sql: Sql): Promise<string> {
    const parts: string[] = [];
    for (const table of TABLES) {
      const [row] = await sql<{ hash: string }[]>`
        SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash FROM ${sql(table)} t
      `;
      parts.push(`${table}:${row?.hash}`);
    }
    return parts.join(",");
  }

  after(async () => {
    for (const { sql, schema } of opened) {
      await sql.end();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
    await admin.end();
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  });

  describe("migrations", () => {
    it("apply every file once and then do nothing", async () => {
      const sql = await freshSchema(false);
      const versions = (await loadMigrations(MIGRATIONS)).map((migration) => migration.version);
      assert.deepEqual((await migrate(sql, MIGRATIONS)).applied, versions);
      const again = await migrate(sql, MIGRATIONS);
      assert.deepEqual(again.applied, []);
      assert.deepEqual(again.alreadyApplied, versions);
    });

    it("refuse to continue when an applied file was edited", async () => {
      const folder = await mkdtemp(join(tmpdir(), "capitalos-migrations-"));
      folders.push(folder);
      await cp(MIGRATIONS, folder, { recursive: true });
      const sql = await freshSchema(false);
      await migrate(sql, folder);
      await appendFile(join(folder, "0001_registry.sql"), "\n-- edited after apply\n");
      await assert.rejects(migrate(sql, folder), /changed after it was applied/);
    });

    it("refuse to continue when an applied file is missing", async () => {
      const folder = await mkdtemp(join(tmpdir(), "capitalos-migrations-"));
      folders.push(folder);
      await cp(MIGRATIONS, folder, { recursive: true });
      const sql = await freshSchema(false);
      await migrate(sql, folder);
      await rm(join(folder, "0005_snapshots.sql"));
      await assert.rejects(migrate(sql, folder), /is missing/);
    });
  });

  describe("fixtures", () => {
    it("seed identical rows in two fresh databases and add nothing on a second run", async () => {
      const first = await freshSchema(true);
      const second = await freshSchema(true);
      const counts = await seedFixtures(first);
      await seedFixtures(second);
      assert.equal(await digest(first), await digest(second));

      const before = await digest(first);
      assert.deepEqual(await seedFixtures(first), counts);
      assert.equal(await digest(first), before);

      assert.equal(counts.quotes, 1);
      assert.equal(counts.workflows, 1);
      assert.ok(counts.markets >= 10 && counts.capabilities >= 18);
    });
  });

  describe("constraints", () => {
    let sql: Sql;
    let quoteId = "";

    before(async () => {
      sql = await freshSchema(true);
      await seedFixtures(sql);
      const [quote] = await sql<{ id: string }[]>`SELECT id FROM quotes`;
      quoteId = quote?.id ?? "";
    });

    it("reject a second workflow with the same idempotency key", async () => {
      await assert.rejects(
        sql`INSERT INTO workflows (id, network, idempotency_key, state, next_action)
            VALUES ('wf_duplicate', 'mainnet', ${FIXTURE_IDEMPOTENCY_KEY}, 'DRAFT', 'REQUOTE')`,
        withCode(UNIQUE),
      );
    });

    it("reject token quantities stored as JSON numbers, and accept strings", async () => {
      const copyQuote = (id: string, input: postgres.JSONValue) => sql`
        INSERT INTO quotes (id, network, market_id, action, input, expected_output, fees, executable,
                            registry_version, adapter_version, expires_at)
        SELECT ${id}, network, market_id, action, ${sql.json(input)}, expected_output, fees, executable,
               registry_version, adapter_version, expires_at
        FROM quotes WHERE id = ${quoteId}`;
      const asset = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
      await assert.rejects(
        copyQuote("q_number", [{ asset, quantity: Number(FIXTURE_ZEST_SUPPLY.amount) }]),
        withCode(CHECK),
      );
      await copyQuote("q_string", [{ asset, quantity: FIXTURE_ZEST_SUPPLY.amount }]);
    });

    it("reject a bare ticker as an asset id", async () => {
      await assert.rejects(
        sql`INSERT INTO assets (id, chain, network, kind, principal, asset_name)
            VALUES ('sBTC', 'stacks', 'mainnet', 'contract', 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token', 'sbtc-token')`,
        withCode(CHECK),
      );
    });

    it("reject an enabled capability without a verified deployment", async () => {
      const insert = (action: string, state: string) => sql`
        INSERT INTO capabilities (network, market_id, action, state, reason, contract_id, adapter_version, registry_version)
        VALUES ('mainnet', 'zest.sbtc.vault', ${action}, ${state}, 'test', 'SP000000000000000000002Q6VF78.pox-5', 'test', '0.1.0')`;
      await assert.rejects(insert("borrow", "enabled"), withCode(CHECK));
      await insert("borrow", "disabled");
    });

    it("allow one canonical block per height and let a reorg replace it", async () => {
      const replace = (canonical: boolean) => sql`
        INSERT INTO chain_blocks (chain, network, hash, height, parent_hash, canonical, source, observed_at)
        VALUES ('stacks', 'mainnet', '0xreplacement', 5000002, '0xparent', ${canonical}, 'test', now())`;
      await assert.rejects(replace(true), withCode(UNIQUE));
      await sql`UPDATE chain_blocks SET canonical = false WHERE network = 'mainnet' AND height = 5000002 AND canonical`;
      await replace(true);
    });

    it("keep raw events immutable except for the canonical flag", async () => {
      await assert.rejects(sql`UPDATE raw_events SET payload = 'tampered'`, withCode(APPEND_ONLY));
      await assert.rejects(sql`DELETE FROM raw_events`, withCode(APPEND_ONLY));
      await sql`UPDATE raw_events SET canonical = false`;
    });

    it("reject empty or duplicate txids and a broadcast without a txid", async () => {
      const [attempt] = await sql<{ txid: string; step_id: string }[]>`SELECT txid, step_id FROM transaction_attempts`;
      const record = (outcome: string, txid: string | null) => sql`
        INSERT INTO transaction_attempts (workflow_id, step_id, chain, network, outcome, txid, evidence)
        VALUES (${FIXTURE_WORKFLOW_ID}, ${attempt?.step_id ?? ""}, 'stacks', 'mainnet', ${outcome}, ${txid}, 'test')`;
      await assert.rejects(record("BROADCAST", ""), withCode(CHECK));
      await assert.rejects(record("BROADCAST", null), withCode(CHECK));
      await assert.rejects(record("BROADCAST", attempt?.txid ?? ""), withCode(UNIQUE));
      await record("UNKNOWN", null);
    });

    it("keep state transitions and transaction attempts append only", async () => {
      await assert.rejects(sql`UPDATE state_transitions SET reason = 'rewritten'`, withCode(APPEND_ONLY));
      await assert.rejects(sql`DELETE FROM transaction_attempts`, withCode(APPEND_ONLY));
    });

    it("store unknown quantities as null with a warning, never silently", async () => {
      const insert = (warnings: string[]) => sql`
        INSERT INTO wallet_balance_snapshots (network, address, asset_id, quantity, stale, warnings, source, observed_at)
        VALUES ('mainnet', 'SP_TEST', 'stacks:mainnet:native:stx', NULL, true, ${warnings}, 'test', now())`;
      await assert.rejects(insert([]), withCode(CHECK));
      await insert(["provider timed out"]);
    });

    it("reject a plan on a different network from its quote", async () => {
      await assert.rejects(
        sql`INSERT INTO plans (id, quote_id, network, registry_version, adapter_version, steps, review_summary, expires_at)
            SELECT 'p_wrong_network', 'q_string', 'testnet', registry_version, adapter_version, steps, review_summary, expires_at
            FROM plans LIMIT 1`,
        withCode(FOREIGN_KEY),
      );
    });

    it("count the rows it seeded", async () => {
      const counts = await countRows(sql);
      assert.ok(TABLES.every((table) => counts[table] > 0));
    });
  });
});
