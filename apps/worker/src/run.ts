import { PROVIDERS } from "@stacks-capital/config";
import { requireNetwork } from "@stacks-capital/core";
import { connect, requireDatabaseUrl } from "@stacks-capital/database";
import { createHiro } from "./hiro.ts";
import { tick } from "./tick.ts";

const network = requireNetwork(process.env.WORKER_NETWORK ?? "mainnet");
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? "60000");
if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("WORKER_INTERVAL_MS must be at least 1000");

const once = process.argv.includes("--once");
const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
const hiro = createHiro({ apiBase: PROVIDERS[network].stacksApi, apiKey: process.env.HIRO_API_KEY });

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

do {
  try {
    const summary = await tick({ sql, hiro, network, at: new Date() });
    console.log(JSON.stringify(summary));
  } catch (error) {
    // A failed tick is never fatal: the checkpoint stays where it is and the next tick retries from there.
    console.error(JSON.stringify({ at: new Date().toISOString(), error: (error as Error).message }));
  }
  if (once || stopping) break;
  await sleep(intervalMs);
} while (!stopping);

await sql.end();
