import { seedFixtures } from "./fixtures.ts";
import { connect, requireDatabaseUrl } from "./lib.ts";

const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
try {
  const counts = await seedFixtures(sql);
  const summary = Object.entries(counts)
    .map(([table, count]) => `${table} ${count}`)
    .join(", ");
  console.log(`Fixtures present: ${summary}.`);
} finally {
  await sql.end();
}
