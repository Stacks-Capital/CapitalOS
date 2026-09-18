import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export type Sql = postgres.Sql;
export type Migration = { version: string; checksum: string; text: string };
export type MigrationResult = { applied: string[]; alreadyApplied: string[] };

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export function requireDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("DATABASE_URL is not set. There is no default database.");
  }
  return value;
}

export function connect(url: string, schema?: string): Sql {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    ...(schema === undefined ? {} : { connection: { search_path: schema } }),
  });
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    if (!MIGRATION_FILE.test(name)) throw new Error(`Migration file names look like 0001_name.sql: ${name}`);
    const text = await readFile(join(dir, name), "utf8");
    const checksum = createHash("sha256").update(text).digest("hex");
    migrations.push({ version: name.slice(0, -".sql".length), checksum, text });
  }
  return migrations;
}

// Applied migrations are never edited. A changed or missing file stops the run instead of silently diverging.
export async function migrate(sql: Sql, dir: string): Promise<MigrationResult> {
  const migrations = await loadMigrations(dir);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('capitalos_migrations'))`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const rows = await tx<{ version: string; checksum: string }[]>`SELECT version, checksum FROM schema_migrations`;
    const known = new Map(rows.map((row) => [row.version, row.checksum]));
    for (const version of known.keys()) {
      if (!migrations.some((migration) => migration.version === version)) {
        throw new Error(`Applied migration ${version} is missing from ${dir}`);
      }
    }

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const migration of migrations) {
      const checksum = known.get(migration.version);
      if (checksum === migration.checksum) {
        result.alreadyApplied.push(migration.version);
        continue;
      }
      if (checksum !== undefined) throw new Error(`Migration ${migration.version} changed after it was applied`);
      await tx.unsafe(migration.text);
      await tx`INSERT INTO schema_migrations (version, checksum) VALUES (${migration.version}, ${migration.checksum})`;
      result.applied.push(migration.version);
    }
    return result;
  });
}
