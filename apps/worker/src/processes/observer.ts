import {
  type NetworkName,
  type Sql,
  insertMarketSnapshot,
  insertPositionSnapshot,
  insertPriceSnapshot,
  insertRewardSnapshot,
  listKnownOwners,
  listMarketAssets,
  listProjectionTargets,
  metricsSnapshot,
  readCheckpoint,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@stacks-capital/database";
import { evaluateAlerts, reconcileAlerts } from "../alerts.ts";
import type { Hiro } from "../hiro.ts";
import { projectMarket } from "../markets.ts";
import { projectOwner, readRewardRate } from "../owners.ts";
import { rewardSnapshot } from "../positions.ts";
import { readPrices } from "../prices.ts";

export type ObserverProcessDeps = {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  intervalMs?: number | undefined;
  priceFeeds?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
  once?: boolean | undefined;
};

export type ObserverSummary = {
  at: string;
  network: NetworkName;
  markets: { written: number; stale: number };
  prices: { written: number; unknown: number };
  positions: { owners: number; written: number; unknown: number };
  rewards: { written: number; stale: number };
};

/**
 * Runs a single tick of the observer process.
 */
export async function observerTick(deps: {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  at: Date;
  priceFeeds?: readonly string[] | undefined;
}): Promise<ObserverSummary> {
  const checkpoint = await readCheckpoint(deps.sql, "stacks", deps.network);
  const block = checkpoint === null ? null : { height: checkpoint.height, hash: checkpoint.hash };
  const targets = await listProjectionTargets(deps.sql, deps.network);

  const summary: ObserverSummary = {
    at: deps.at.toISOString(),
    network: deps.network,
    markets: { written: 0, stale: 0 },
    prices: { written: 0, unknown: 0 },
    positions: { owners: 0, written: 0, unknown: 0 },
    rewards: { written: 0, stale: 0 },
  };

  // 1. Markets
  for (const target of targets) {
    const observed = await projectMarket(deps.hiro, deps.network, target, block, deps.at);
    if (await insertMarketSnapshot(deps.sql, observed)) summary.markets.written += 1;
    if (observed.stale) summary.markets.stale += 1;
  }

  // 2. Rewards
  for (const target of targets) {
    const reading = await readRewardRate(deps.hiro, target);
    const row = rewardSnapshot(deps.network, reading, target.marketId, target.adapterVersion, deps.at, block);
    if (await insertRewardSnapshot(deps.sql, row)) summary.rewards.written += 1;
    if (row.stale) summary.rewards.stale += 1;
  }

  // 3. Positions for known owners
  const marketAssets = await listMarketAssets(deps.sql, deps.network);
  for (const owner of await listKnownOwners(deps.sql, deps.network)) {
    summary.positions.owners += 1;
    const projected = await projectOwner(deps.hiro, {
      network: deps.network,
      owner,
      targets,
      markets: marketAssets,
      at: deps.at,
      block,
    });
    for (const row of projected.rows) {
      if (await insertPositionSnapshot(deps.sql, row)) summary.positions.written += 1;
      if (row.quantity === null) summary.positions.unknown += 1;
    }
  }

  // 4. Prices
  const prices = await readPrices(deps.hiro, {
    network: deps.network,
    sender: deps.network === "mainnet" ? "SP000000000000000000002Q6VF78" : "ST000000000000000000002AMW42H",
    at: deps.at,
    ...(deps.priceFeeds ? { feeds: deps.priceFeeds } : {}),
  });
  for (const price of prices) {
    if (await insertPriceSnapshot(deps.sql, price)) summary.prices.written += 1;
    if (price.price === null) summary.prices.unknown += 1;
  }

  // 5. Alerts evaluation
  try {
    const snapshot = await metricsSnapshot(deps.sql, {
      network: deps.network,
      at: deps.at,
      windowSeconds: 15 * 60,
    });
    const { notifications } = await reconcileAlerts(deps.sql, deps.network, evaluateAlerts(snapshot), deps.at);
    for (const notification of notifications) {
      console.log(JSON.stringify({ process: "observer", alert: notification }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        process: "observer",
        at: deps.at.toISOString(),
        alertsError: (error as Error).message,
      }),
    );
  }

  return summary;
}

/**
 * Runs the continuous observer loop for market projections, DIA oracle prices, rewards,
 * owner positions, metrics, and alert evaluation.
 * Uses PostgreSQL advisory lock ("observer") to enforce single-runner per network.
 */
export async function runObserver(deps: ObserverProcessDeps): Promise<void> {
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
        lockAcquired = await tryAcquireWorkerLock(deps.sql, "observer", deps.network);
        if (!lockAcquired) {
          console.warn(
            JSON.stringify({
              level: "warn",
              process: "observer",
              network: deps.network,
              message: "Observer lock held by another instance. Retrying...",
            }),
          );
          if (deps.once) break;
          await sleep(Math.min(intervalMs, 10_000));
          continue;
        }
      }

      const at = new Date();
      try {
        const summary = await observerTick({
          sql: deps.sql,
          hiro: deps.hiro,
          network: deps.network,
          at,
          ...(deps.priceFeeds !== undefined ? { priceFeeds: deps.priceFeeds } : {}),
        });
        console.log(JSON.stringify({ process: "observer", ...summary }));
      } catch (error) {
        console.error(
          JSON.stringify({
            process: "observer",
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
      await releaseWorkerLock(deps.sql, "observer", deps.network).catch(() => {});
    }
  }
}
