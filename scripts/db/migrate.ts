import { fileURLToPath } from "node:url";
import { connect, migrate, requireDatabaseUrl } from "./lib.ts";

const dir = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
try {
  const result = await migrate(sql, dir);
  console.log(`Applied: ${result.applied.join(", ") || "none"}. Already applied: ${result.alreadyApplied.length}.`);
} finally {
  await sql.end();
}
