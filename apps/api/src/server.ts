import { serve } from "@hono/node-server";
import { connect, requireDatabaseUrl } from "@stacks-capital/database";
import { createApp } from "./app.ts";

const port = Number(process.env.API_PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("API_PORT must be a port number");

const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
serve({ fetch: createApp({ sql }).fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`Capital OS API listening on http://127.0.0.1:${info.port}`);
});
