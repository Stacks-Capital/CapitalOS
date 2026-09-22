import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedFixtures } from "./fixtures.ts";
import { createApiKey } from "./identity.ts";
import { connect, MIGRATIONS_DIR, migrate, requireDatabaseUrl, type Sql } from "./lib.ts";

/*
 * Proves the backup and restore procedure in docs/runbooks/backup-restore.md works, rather than
 * trusting that it does. It builds a scratch schema with every table populated, backs it up with
 * pg_dump, drops it, restores it with pg_restore, and checks that every row came back unchanged and
 * that the migration history still matches the files. Run with: pnpm db:restore-drill
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function compose(args: string[], input?: Buffer): Buffer {
  const envFile = existsSync(`${repoRoot}.env.local`) ? ["--env-file", ".env.local"] : [];
  return execFileSync("docker", ["compose", ...envFile, "exec", "-T", "postgres", ...args], {
    cwd: repoRoot,
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
}

type Snapshot = Record<string, { rows: number; checksum: string }>;

// A checksum per table over every row, so a restore that loses or alters any value is caught.
async function snapshot(sql: Sql, schema: string): Promise<Snapshot> {
  const tables = await sql<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' ORDER BY table_name
  `;
  const result: Snapshot = {};
  for (const { name } of tables) {
    const [row] = await sql.unsafe<{ rows: number; checksum: string | null }[]>(
      `SELECT count(*)::int AS rows,
              md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS checksum
       FROM "${schema}"."${name}" t`,
    );
    result[name] = { rows: row?.rows ?? 0, checksum: row?.checksum ?? "" };
  }
  return result;
}

const url = requireDatabaseUrl(process.env.DATABASE_URL);
const schema = `restore_drill_${randomBytes(4).toString("hex")}`;
const admin = connect(url);
const started = Date.now();

try {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const before = connect(url, schema);
  await migrate(before, MIGRATIONS_DIR);
  await seedFixtures(before);
  // A key proves identity rows survive. Only its hash is stored, so the secret is not in the backup.
  await createApiKey(before, { appId: "app_fixture", scopes: ["markets:read"] });
  const original = await snapshot(before, schema);
  await before.end();

  const backupStarted = Date.now();
  const dump = compose(["pg_dump", "-U", "stacks_capital", "-d", "stacks_capital", "-n", schema, "-Fc"]);
  const backupMs = Date.now() - backupStarted;

  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);

  const restoreStarted = Date.now();
  compose(["pg_restore", "-U", "stacks_capital", "-d", "stacks_capital", "--no-owner", "--exit-on-error"], dump);
  const restoreMs = Date.now() - restoreStarted;

  const after = connect(url, schema);
  const restored = await snapshot(after, schema);
  // Nothing should be pending and no checksum should disagree: the history came back intact.
  const rerun = await migrate(after, MIGRATIONS_DIR);
  await after.end();

  const differences = Object.keys({ ...original, ...restored }).filter(
    (table) => JSON.stringify(original[table]) !== JSON.stringify(restored[table]),
  );
  const result = {
    schema,
    tables: Object.keys(original).length,
    rows: Object.values(original).reduce((sum, table) => sum + table.rows, 0),
    backupBytes: dump.length,
    backupMs,
    restoreMs,
    totalMs: Date.now() - started,
    differences,
    migrationsAppliedAfterRestore: rerun.applied,
    passed: differences.length === 0 && rerun.applied.length === 0,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
