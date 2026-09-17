import { connect, MIGRATIONS_DIR, migrate, requireDatabaseUrl } from "./lib.ts";

const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
try {
  const result = await migrate(sql, MIGRATIONS_DIR);
  console.log(`Applied: ${result.applied.join(", ") || "none"}. Already applied: ${result.alreadyApplied.length}.`);
} finally {
  await sql.end();
}
