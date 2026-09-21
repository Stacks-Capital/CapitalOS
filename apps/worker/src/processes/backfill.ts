import type { Hiro } from "../hiro.ts";
import { ingestBlocks, ingestEvents } from "../ingest.ts";
import {
  type NetworkName,
  type Sql,
  listProjectionTargets,
  readCheckpoint,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@stacks-capital/database";

const CHAIN = "stacks" as const;

export type BackfillOptions = {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  fromHeight?: number | undefined;
  toHeight?: number | undefined;
  maxBlocksPerBatch?: number | undefined;
  perContract?: number | undefined;
  at?: Date | undefined;
  onProgress?:
    | ((progress: {
        currentHeight: number;
        targetHeight: number;
        blocksIngested: number;
        eventsIngested: number;
      }) => void)
    | undefined;
};

export type BackfillResult = {
  network: NetworkName;
  fromHeight: number;
  toHeight: number;
  blocksIngested: number;
  eventsIngested: number;
  activitiesIngested: number;
  durationMs: number;
  status: "completed" | "interrupted" | "lock_failed";
};

/**
 * Executes a one-shot historical backfill of blocks and contract events up to a bounded target height.
 * Guarantees finite execution: terminates cleanly upon reaching the target height.
 * Uses PostgreSQL advisory locks to prevent concurrent backfill runs on the same network.
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const at = opts.at ?? new Date();
  const startTime = Date.now();
  const maxBatch = opts.maxBlocksPerBatch ?? 50;

  const acquired = await tryAcquireWorkerLock(opts.sql, "backfill", opts.network);
  if (!acquired) {
    console.warn(
      JSON.stringify({
        level: "warn",
        process: "backfill",
        network: opts.network,
        message: "Another backfill process is already running for this network. Exiting.",
      }),
    );
    return {
      network: opts.network,
      fromHeight: opts.fromHeight ?? 0,
      toHeight: opts.toHeight ?? 0,
      blocksIngested: 0,
      eventsIngested: 0,
      activitiesIngested: 0,
      durationMs: Date.now() - startTime,
      status: "lock_failed",
    };
  }

  try {
    const tip = await opts.hiro.latestBlock();
    const existingCheckpoint = await readCheckpoint(opts.sql, CHAIN, opts.network);

    let startHeight: number;
    if (opts.fromHeight !== undefined) {
      startHeight = opts.fromHeight;
    } else if (existingCheckpoint !== null) {
      startHeight = existingCheckpoint.height;
    } else {
      startHeight = 0;
    }

    const targetHeight = opts.toHeight !== undefined ? Math.min(opts.toHeight, tip.height) : tip.height;

    let totalBlocks = 0;
    let totalEvents = 0;
    let totalActivities = 0;

    let currentHeight = startHeight;
    const targets = await listProjectionTargets(opts.sql, opts.network);

    console.log(
      JSON.stringify({
        level: "info",
        process: "backfill",
        network: opts.network,
        fromHeight: startHeight,
        targetHeight,
        tipHeight: tip.height,
        message: `Starting backfill from block ${startHeight} to ${targetHeight}`,
      }),
    );

    // If starting from before or at checkpoint, step forward in batches
    while (currentHeight < targetHeight) {
      const batchEnd = Math.min(targetHeight, currentHeight + maxBatch);
      const batchSize = batchEnd - currentHeight;

      const blockResult = await ingestBlocks({
        sql: opts.sql,
        hiro: opts.hiro,
        network: opts.network,
        at,
        maxBlocks: batchSize,
      });

      totalBlocks += blockResult.blocks;
      currentHeight = blockResult.checkpoint?.height ?? currentHeight + blockResult.blocks;

      // Ingest events for known targets
      if (targets.length > 0) {
        const eventResult = await ingestEvents({
          sql: opts.sql,
          hiro: opts.hiro,
          network: opts.network,
          at,
          targets,
          perContract: opts.perContract ?? 50,
        });
        totalEvents += eventResult.events;
        totalActivities += eventResult.activities;
      }

      opts.onProgress?.({
        currentHeight,
        targetHeight,
        blocksIngested: totalBlocks,
        eventsIngested: totalEvents,
      });

      // If no blocks were made (e.g. reached tip or reorg pause), break to avoid infinite loop
      if (blockResult.blocks === 0 && (blockResult.checkpoint?.height ?? 0) >= targetHeight) {
        break;
      }
      if (blockResult.blocks === 0) {
        // Tip was reached or progress stalled
        break;
      }
    }

    console.log(
      JSON.stringify({
        level: "info",
        process: "backfill",
        network: opts.network,
        fromHeight: startHeight,
        toHeight: currentHeight,
        blocksIngested: totalBlocks,
        eventsIngested: totalEvents,
        activitiesIngested: totalActivities,
        durationMs: Date.now() - startTime,
        status: "completed",
      }),
    );

    return {
      network: opts.network,
      fromHeight: startHeight,
      toHeight: currentHeight,
      blocksIngested: totalBlocks,
      eventsIngested: totalEvents,
      activitiesIngested: totalActivities,
      durationMs: Date.now() - startTime,
      status: "completed",
    };
  } finally {
    await releaseWorkerLock(opts.sql, "backfill", opts.network).catch(() => {});
  }
}
