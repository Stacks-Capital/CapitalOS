import http from "node:http";
import { requireNetwork } from "@stacks-capital/core";
import {
  type NetworkName,
  type Sql,
  connect,
  metricsSnapshot,
  openAlerts,
  requireDatabaseUrl,
} from "@stacks-capital/database";

export type HealthServerDeps = {
  sql: Sql;
  network: NetworkName;
  port: number;
  host?: string;
  signal?: AbortSignal;
};

export type HealthStatus = {
  status: "ok" | "degraded" | "unhealthy";
  network: NetworkName;
  timestamp: string;
  ingestion: {
    checkpointHeight: number | null;
    checkpointHash: string | null;
    checkpointAt: string | null;
    blocksBehind: number | null;
    lastTickAt: string | null;
    failuresInWindow: number;
  };
  alerts: Array<{
    kind: string;
    severity: string;
    subject: string;
    message: string;
  }>;
};

/**
 * Collects current health status metrics from the database.
 */
export async function getHealthStatus(sql: Sql, network: NetworkName): Promise<HealthStatus> {
  const at = new Date();
  const snapshot = await metricsSnapshot(sql, { network, at, windowSeconds: 15 * 60 });
  const activeAlerts = await openAlerts(sql, network);

  let status: HealthStatus["status"] = "ok";
  const blocksBehind = snapshot.ingestion.blocksBehind ?? 0;
  const failures = snapshot.ingestion.failuresInWindow;

  if (failures > 10 || blocksBehind > 20) {
    status = "unhealthy";
  } else if (failures > 0 || blocksBehind > 5) {
    status = "degraded";
  }

  return {
    status,
    network,
    timestamp: at.toISOString(),
    ingestion: {
      checkpointHeight: snapshot.ingestion.checkpointHeight,
      checkpointHash: snapshot.ingestion.checkpointHash,
      checkpointAt: snapshot.ingestion.checkpointAt?.toISOString() ?? null,
      blocksBehind: snapshot.ingestion.blocksBehind,
      lastTickAt: snapshot.ingestion.lastTickAt?.toISOString() ?? null,
      failuresInWindow: snapshot.ingestion.failuresInWindow,
    },
    alerts: activeAlerts.map((a) => ({
      kind: a.kind,
      severity: a.severity,
      subject: a.subject,
      message: a.message,
    })),
  };
}

/**
 * Starts a lightweight HTTP server serving health, readiness, and metrics status endpoints.
 */
export function startHealthServer(deps: HealthServerDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    if (url.pathname === "/health" || url.pathname === "/livez") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    if (url.pathname === "/readyz") {
      try {
        const [row] = await deps.sql<{ ok: number }[]>`SELECT 1 AS ok`;
        if (row?.ok === 1) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: true, network: deps.network }));
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, error: "Database returned unexpected response" }));
        }
      } catch (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready: false, error: (err as Error).message }));
      }
      return;
    }

    if (url.pathname === "/status") {
      try {
        const status = await getHealthStatus(deps.sql, deps.network);
        const statusCode = status.status === "unhealthy" ? 503 : 200;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: (err as Error).message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  server.listen(deps.port, deps.host ?? "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        level: "info",
        service: "worker-health",
        port: deps.port,
        network: deps.network,
        message: `Worker health server listening on port ${deps.port}`,
      }),
    );
  });

  deps.signal?.addEventListener(
    "abort",
    () => {
      server.close();
    },
    { once: true },
  );

  return server;
}

// CLI entrypoint for container HEALTHCHECK: node apps/worker/src/health.ts --cli
if (process.argv.includes("--cli")) {
  const network = requireNetwork(process.env.WORKER_NETWORK ?? "mainnet");
  const databaseUrl = requireDatabaseUrl(process.env.DATABASE_URL);
  const sql = connect(databaseUrl);

  try {
    const status = await getHealthStatus(sql, network);
    console.log(JSON.stringify(status));
    await sql.end();
    if (status.status === "unhealthy") {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (error) {
    console.error(JSON.stringify({ error: (error as Error).message }));
    await sql.end().catch(() => {});
    process.exit(1);
  }
}
