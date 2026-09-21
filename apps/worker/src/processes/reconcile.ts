import {
  type NetworkName,
  type Sql,
  latestMarketSnapshot,
  listProjectionTargets,
  readCheckpoint,
  recordReconciliation,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@stacks-capital/database";
import type { Hiro } from "../hiro.ts";
import { PROJECTION_SOURCE, projectMarket, reconciliation } from "../markets.ts";

export type ReconcileProcessDeps = {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  intervalMs?: number | undefined;
  signal?: AbortSignal | undefined;
  once?: boolean | undefined;
};

export type ReconcileSummary = {
  at: string;
  network: NetworkName;
  reconciliation: { match: number; mismatch: number; unavailable: number };
  targetsChecked: number;
};

/**
 * Runs a single tick of the reconciliation process.
 */
export async function reconcileTick(deps: {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  at: Date;
}): Promise<ReconcileSummary> {
  const checkpoint = await readCheckpoint(deps.sql, "stacks", deps.network);
  const block = checkpoint === null ? null : { height: checkpoint.height, hash: checkpoint.hash };
  const targets = await listProjectionTargets(deps.sql, deps.network);

  const summary: ReconcileSummary = {
    at: deps.at.toISOString(),
    network: deps.network,
    reconciliation: { match: 0, mismatch: 0, unavailable: 0 },
    targetsChecked: targets.length,
  };

  for (const target of targets) {
    const projected = await latestMarketSnapshot(deps.sql, {
      network: deps.network,
      marketId: target.marketId,
      source: PROJECTION_SOURCE,
    });
    const observed = await projectMarket(deps.hiro, deps.network, target, block, deps.at);
    const run = reconciliation(deps.network, target, projected, observed, deps.at);
    await recordReconciliation(deps.sql, run);
    summary.reconciliation[run.status] += 1;
  }

  return summary;
}

/**
 * Runs the continuous reconciliation loop comparing projected state with observed chain state.
 * Uses PostgreSQL advisory lock ("reconcile") to enforce single-runner per network.
 */
export async function runReconcile(deps: ReconcileProcessDeps): Promise<void> {
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
        lockAcquired = await tryAcquireWorkerLock(deps.sql, "reconcile", deps.network);
        if (!lockAcquired) {
          console.warn(
            JSON.stringify({
              level: "warn",
              process: "reconcile",
              network: deps.network,
              message: "Reconciliation lock held by another instance. Retrying...",
            }),
          );
          if (deps.once) break;
          await sleep(Math.min(intervalMs, 10_000));
          continue;
        }
      }

      const at = new Date();
      try {
        const summary = await reconcileTick({
          sql: deps.sql,
          hiro: deps.hiro,
          network: deps.network,
          at,
        });
        console.log(JSON.stringify({ process: "reconcile", ...summary }));
      } catch (error) {
        console.error(
          JSON.stringify({
            process: "reconcile",
            at: at.toISOString(),
            error: (error as Error).message,
          }),
        );
      }

      if (deps.once || deps.signal?.aborted) break;
      await sleep(intervalMs);
    } while (!deps.signal?.aborted);
  } finally {
    if (lockAcquired) {
      await releaseWorkerLock(deps.sql, "reconcile", deps.network).catch(() => {});
    }
  }
}
