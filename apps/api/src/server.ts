import { serve } from "@hono/node-server";
import { connect, requireDatabaseUrl } from "@stacks-capital/database";
import { verifyBuiltinRegistry } from "@stacks-capital/engine";
import { createApp } from "./app.ts";
import { redisClient, redisLimiter } from "./rateLimit.ts";

const port = Number(process.env.API_PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("API_PORT must be a port number");

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || redisUrl === "") throw new Error("REDIS_URL is not set. Rate limits need Redis.");

await verifyBuiltinRegistry();

const redis = redisClient(redisUrl);
await Promise.race([
  redis.connect(),
  new Promise((_, reject) => setTimeout(() => reject(new Error("Could not reach Redis at REDIS_URL")), 5_000).unref()),
]);

const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
serve({ fetch: createApp({ sql, limiter: redisLimiter(redis) }).fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`Capital OS API listening on http://127.0.0.1:${info.port}`);
});
