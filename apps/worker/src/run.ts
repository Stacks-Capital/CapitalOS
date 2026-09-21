import { PROVIDERS, verifyBuiltinRegistry } from "@stacks-capital/config";
import { requireNetwork } from "@stacks-capital/core";
import { connect, metricsSnapshot, recordOpsEvent, requireDatabaseUrl } from "@stacks-capital/database";
import { evaluateAlerts, reconcileAlerts } from "./alerts.ts";
import { createHiro } from "./hiro.ts";
import { tick } from "./tick.ts";

const network = requireNetwork(process.env.WORKER_NETWORK ?? "mainnet");
await verifyBuiltinRegistry();
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
  const at = new Date();
  try {
    const summary = await tick({ sql, hiro, network, at });
    console.log(JSON.stringify(summary));
  } catch (error) {
    // A failed tick is never fatal: the checkpoint stays where it is and the next tick retries from there.
    console.error(JSON.stringify({ at: at.toISOString(), error: (error as Error).message }));
    await recordOpsEvent(sql, {
      kind: "ingestion_failed",
      network,
      subject: "stacks",
      code: (error as { code?: string }).code ?? "UNCLASSIFIED",
      at,
    }).catch(() => {});
  }
  try {
    const snapshot = await metricsSnapshot(sql, { network, at: new Date(), windowSeconds: 15 * 60 });
    const { notifications } = await reconcileAlerts(sql, network, evaluateAlerts(snapshot), new Date());
    // Only changes are printed: a problem that persists does not repeat itself every tick.
    for (const notification of notifications) console.log(JSON.stringify({ alert: notification }));
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), alertsError: (error as Error).message }));
  }
  if (once || stopping) break;
  await sleep(intervalMs);
} while (!stopping);

await sql.end();
