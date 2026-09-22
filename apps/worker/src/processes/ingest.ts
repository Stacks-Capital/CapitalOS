import type { Hiro } from "../hiro.ts";
import { ingestBlocks, ingestEvents } from "../ingest.ts";
import {
  type NetworkName,
  type Sql,
  listProjectionTargets,
  recordOpsEvent,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@stacks-capital/database";

export type IngestProcessDeps = {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  intervalMs?: number | undefined;
  maxBlocks?: number | undefined;
  signal?: AbortSignal | undefined;
  once?: boolean | undefined;
};

export type IngestSummary = {
  at: string;
  network: NetworkName;
  tipHeight: number;
  blocks: number;
  reorg: { ancestorHash: string; blocks: number; events: number; activities: number } | null;
  events: number;
  activities: number;
};

/**
 * Runs a single tick of the ingestion process.
 */
export async function ingestTick(deps: {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  at: Date;
  maxBlocks?: number | undefined;
}): Promise<IngestSummary> {
  const ingested = await ingestBlocks({
    sql: deps.sql,
    hiro: deps.hiro,
    network: deps.network,
    at: deps.at,
    ...(deps.maxBlocks !== undefined ? { maxBlocks: deps.maxBlocks } : {}),
  });

  // How far behind the chain this tick left us.
  await recordOpsEvent(deps.sql, {
    kind: "ingestion_tick",
    network: deps.network,
    subject: "stacks",
    value: ingested.checkpoint === null ? null : Math.max(0, ingested.tipHeight - ingested.checkpoint.height),
    at: deps.at,
  });

  const targets = await listProjectionTargets(deps.sql, deps.network);
  const events = await ingestEvents({
    sql: deps.sql,
    hiro: deps.hiro,
    network: deps.network,
    at: deps.at,
    targets,
    ...(deps.maxBlocks !== undefined ? { maxBlocks: deps.maxBlocks } : {}),
  });

  return {
    at: deps.at.toISOString(),
    network: deps.network,
    tipHeight: ingested.tipHeight,
    blocks: ingested.blocks,
    reorg: ingested.reorg,
    events: events.events,
    activities: events.activities,
  };
}

/**
 * Runs the continuous ingestion loop for blocks, raw contract events, checkpoints, and reorgs.
 * Uses PostgreSQL advisory lock ("ingest") to enforce single-runner per network.
 */
export async function runIngest(deps: IngestProcessDeps): Promise<void> {
  const intervalMs = deps.intervalMs ?? 60_000;
  let lockAcquired = false;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      deps.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  try {
    do {
      if (deps.signal?.aborted) break;

      if (!lockAcquired) {
        lockAcquired = await tryAcquireWorkerLock(deps.sql, "ingest", deps.network);
        if (!lockAcquired) {
          console.warn(
            JSON.stringify({
              level: "warn",
              process: "ingest",
              network: deps.network,
              message: "Ingestion lock held by another instance. Retrying...",
            }),
          );
          if (deps.once) break;
          await sleep(Math.min(intervalMs, 10_000));
          continue;
        }
      }

      const at = new Date();
      try {
        const summary = await ingestTick({
          sql: deps.sql,
          hiro: deps.hiro,
          network: deps.network,
          at,
          maxBlocks: deps.maxBlocks,
        });
        console.log(JSON.stringify({ process: "ingest", ...summary }));
      } catch (error) {
        console.error(
          JSON.stringify({
            process: "ingest",
            at: at.toISOString(),
            error: (error as Error).message,
          }),
        );
        await recordOpsEvent(deps.sql, {
          kind: "ingestion_failed",
          network: deps.network,
          subject: "stacks",
          code: (error as { code?: string }).code ?? "UNCLASSIFIED",
          at,
        }).catch(() => {});
      }

      if (deps.once || deps.signal?.aborted) break;
      await sleep(intervalMs);
    } while (!deps.signal?.aborted);
  } finally {
    if (lockAcquired) {
      await releaseWorkerLock(deps.sql, "ingest", deps.network).catch(() => {});
    }
  }
}
