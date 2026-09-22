import { PROVIDERS, verifyBuiltinRegistry } from "@stacks-capital/config";
import { requireNetwork } from "@stacks-capital/core";
import {
  connect,
  metricsSnapshot,
  recordOpsEvent,
  releaseWorkerLock,
  requireDatabaseUrl,
  tryAcquireWorkerLock,
} from "@stacks-capital/database";
import { auditProjections } from "./audit.ts";
import { evaluateAlerts, reconcileAlerts } from "./alerts.ts";
import { startHealthServer } from "./health.ts";
import { createHiro } from "./hiro.ts";
import { runBackfill } from "./processes/backfill.ts";
import { runIngest } from "./processes/ingest.ts";
import { runObserver } from "./processes/observer.ts";
import { runReconcile } from "./processes/reconcile.ts";
import { tick } from "./tick.ts";

function parseArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(`--${flag}`);
  if (index !== -1 && index + 1 < process.argv.length && !process.argv[index + 1]?.startsWith("--")) {
    return process.argv[index + 1];
  }
  return undefined;
}

const network = requireNetwork(process.env.WORKER_NETWORK ?? "mainnet");
await verifyBuiltinRegistry();

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? "60000");
if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
  throw new Error("WORKER_INTERVAL_MS must be at least 1000");
}

const once = process.argv.includes("--once");
const selectedProcess = (parseArg("process") ?? process.env.WORKER_PROCESS ?? "all").toLowerCase();

const healthPortRaw = parseArg("health-port") ?? process.env.WORKER_HEALTH_PORT;
const healthPort = healthPortRaw ? Number(healthPortRaw) : undefined;
if (healthPort !== undefined && (!Number.isInteger(healthPort) || healthPort <= 0 || healthPort > 65535)) {
  throw new Error("WORKER_HEALTH_PORT must be a valid port number (1-65535)");
}

const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
const hiro = createHiro({ apiBase: PROVIDERS[network].stacksApi, apiKey: process.env.HIRO_API_KEY });

const abortController = new AbortController();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  abortController.abort();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Start health server if requested
if (healthPort !== undefined) {
  startHealthServer({
    sql,
    network,
    port: healthPort,
    signal: abortController.signal,
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    abortController.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

switch (selectedProcess) {
  case "audit": {
    const report = await auditProjections({
      sql,
      network,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.isHealthy) {
      process.exitCode = 1;
    }
    break;
  }

  case "backfill": {
    const fromHeightRaw = parseArg("from-height") ?? process.env.BACKFILL_FROM_HEIGHT;
    const toHeightRaw = parseArg("to-height") ?? process.env.BACKFILL_TO_HEIGHT;
    const batchSizeRaw = parseArg("batch-size") ?? process.env.BACKFILL_BATCH_SIZE;
    const reproject = process.argv.includes("--reproject");
    const audit = process.argv.includes("--audit");

    const fromHeight = fromHeightRaw ? Number(fromHeightRaw) : undefined;
    const toHeight = toHeightRaw ? Number(toHeightRaw) : undefined;
    const maxBlocksPerBatch = batchSizeRaw ? Number(batchSizeRaw) : undefined;

    const result = await runBackfill({
      sql,
      hiro,
      network,
      ...(fromHeight !== undefined ? { fromHeight } : {}),
      ...(toHeight !== undefined ? { toHeight } : {}),
      ...(maxBlocksPerBatch !== undefined ? { maxBlocksPerBatch } : {}),
      ...(reproject ? { reproject: true } : {}),
      ...(audit ? { audit: true } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case "ingest": {
    await runIngest({
      sql,
      hiro,
      network,
      intervalMs,
      signal: abortController.signal,
      once,
    });
    break;
  }

  case "observer": {
    await runObserver({
      sql,
      hiro,
      network,
      intervalMs,
      signal: abortController.signal,
      once,
    });
    break;
  }

  case "reconcile": {
    await runReconcile({
      sql,
      hiro,
      network,
      intervalMs,
      signal: abortController.signal,
      once,
    });
    break;
  }

  case "all": {
    // Default mode: monolithic tick loop for local development and backwards compatibility
    let lockAcquired = false;
    try {
      do {
        if (stopping) break;

        if (!lockAcquired) {
          lockAcquired = await tryAcquireWorkerLock(sql, "all", network);
          if (!lockAcquired) {
            console.warn(
              JSON.stringify({
                level: "warn",
                process: "all",
                network,
                message: "Worker (all) lock held by another instance. Retrying...",
              }),
            );
            if (once) break;
            await sleep(Math.min(intervalMs, 10_000));
            continue;
          }
        }

        const at = new Date();
        try {
          const summary = await tick({ sql, hiro, network, at });
          console.log(JSON.stringify(summary));
        } catch (error) {
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
          for (const notification of notifications) {
            console.log(JSON.stringify({ alert: notification }));
          }
        } catch (error) {
          console.error(JSON.stringify({ at: new Date().toISOString(), alertsError: (error as Error).message }));
        }

        if (once || stopping) break;
        await sleep(intervalMs);
      } while (!stopping);
    } finally {
      if (lockAcquired) {
        await releaseWorkerLock(sql, "all", network).catch(() => {});
      }
    }
    break;
  }

  default:
    console.error(
      `Unknown worker process: "${selectedProcess}". Expected one of: all, ingest, observer, reconcile, backfill`,
    );
    process.exitCode = 1;
}

await sql.end();
