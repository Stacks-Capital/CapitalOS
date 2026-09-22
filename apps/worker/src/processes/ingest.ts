import type { Hiro } from "../hiro.ts";
import { ingestBlocks, ingestEvents } from "../ingest.ts";
import {
  type CheckpointRow,
  type NetworkName,
  type Sql,
  listProjectionTargets,
  recordOpsEvent,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@stacks-capital/database";
import { observerTick } from "./observer.ts";

export type IngestProcessDeps = {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  intervalMs?: number | undefined;
  maxBlocks?: number | undefined;
  advanceProjections?: boolean | undefined;
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
  projectionsAdvanced?: boolean | undefined;
};

export type ReorgReplayResult = {
  ancestorHash: string;
  orphanedBlocks: number;
  orphanedEvents: number;
  orphanedActivities: number;
  rebuiltBlocks: number;
  rebuiltEvents: number;
  rebuiltActivities: number;
  newCheckpoint: CheckpointRow | null;
};

/**
 * Runs a single tick of the ingestion process.
 * If advanceProjections is true and new blocks or a reorg occurred, automatically
 * advances canonical market and price projections without manual commands.
 */
export async function ingestTick(deps: {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  at: Date;
  maxBlocks?: number | undefined;
  advanceProjections?: boolean | undefined;
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

  let projectionsAdvanced = false;
  if (deps.advanceProjections && (ingested.blocks > 0 || ingested.reorg !== null)) {
    await observerTick({
      sql: deps.sql,
      hiro: deps.hiro,
      network: deps.network,
      at: deps.at,
    });
    projectionsAdvanced = true;
  }

  return {
    at: deps.at.toISOString(),
    network: deps.network,
    tipHeight: ingested.tipHeight,
    blocks: ingested.blocks,
    reorg: ingested.reorg,
    events: events.events,
    activities: events.activities,
    ...(projectionsAdvanced ? { projectionsAdvanced: true } : {}),
  };
}

/**
 * Replays a reorg from the common ancestor: marks orphaned evidence noncanonical,
 * rewinds the checkpoint, ingests the replacement canonical fork, and rebuilds affected state.
 */
export async function reorgReplay(deps: {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  at: Date;
  advanceProjections?: boolean | undefined;
}): Promise<ReorgReplayResult> {
  // Step 1: Detect reorg, walk back to ancestor, and mark orphaned blocks/events noncanonical
  const reorgStep = await ingestBlocks({
    sql: deps.sql,
    hiro: deps.hiro,
    network: deps.network,
    at: deps.at,
    maxBlocks: 0,
  });

  if (reorgStep.reorg === null) {
    throw new Error("No reorg detected at current checkpoint");
  }

  // Step 2: Ingest the new canonical fork forward from the ancestor
  const newFork = await ingestBlocks({
    sql: deps.sql,
    hiro: deps.hiro,
    network: deps.network,
    at: deps.at,
  });

  // Step 3: Ingest events for the target contracts on the new fork
  const targets = await listProjectionTargets(deps.sql, deps.network);
  const events = await ingestEvents({
    sql: deps.sql,
    hiro: deps.hiro,
    network: deps.network,
    at: deps.at,
    targets,
  });

  // Step 4: Rebuild projections for the new canonical fork
  if (deps.advanceProjections !== false) {
    await observerTick({
      sql: deps.sql,
      hiro: deps.hiro,
      network: deps.network,
      at: deps.at,
    });
  }

  return {
    ancestorHash: reorgStep.reorg.ancestorHash,
    orphanedBlocks: reorgStep.reorg.blocks,
    orphanedEvents: reorgStep.reorg.events,
    orphanedActivities: reorgStep.reorg.activities,
    rebuiltBlocks: newFork.blocks,
    rebuiltEvents: events.events,
    rebuiltActivities: events.activities,
    newCheckpoint: newFork.checkpoint,
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
          advanceProjections: deps.advanceProjections,
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
