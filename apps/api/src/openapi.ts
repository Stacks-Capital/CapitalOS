import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Sql } from "@stacks-capital/database";
import { createApp, OPENAPI_CONFIG } from "./app.ts";
import { memoryLimiter } from "./rateLimit.ts";

const target = fileURLToPath(new URL("../openapi.json", import.meta.url));

// Describing routes never touches the database.
const unusedDatabase = (() => {
  throw new Error("The OpenAPI document must not query the database");
}) as unknown as Sql;

export function openApiDocument(): string {
  return `${JSON.stringify(createApp({ sql: unusedDatabase, limiter: memoryLimiter() }).getOpenAPI31Document(OPENAPI_CONFIG), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = openApiDocument();
  if (process.argv.includes("--check")) {
    const committed = await readFile(target, "utf8").catch(() => "");
    if (committed !== generated) {
      console.error("apps/api/openapi.json is out of date. Run pnpm openapi:write and commit the result.");
      process.exit(1);
    }
    console.log("apps/api/openapi.json matches the runtime schemas.");
  } else {
    await writeFile(target, generated);
    console.log("Wrote apps/api/openapi.json.");
  }
}
