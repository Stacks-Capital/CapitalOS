import {
  insertMarketSnapshot,
  insertPriceSnapshot,
  latestMarketSnapshot,
  listProjectionTargets,
  type NetworkName,
  recordReconciliation,
  type Sql,
} from "@stacks-capital/database";
import type { Hiro } from "./hiro.ts";
import { ingestBlocks, ingestEvents } from "./ingest.ts";
import { PROJECTION_SOURCE, projectMarket, reconciliation } from "./markets.ts";
import { readPrices } from "./prices.ts";

export type TickDeps = {
  sql: Sql;
  hiro: Hiro;
  network: NetworkName;
  at: Date;
  maxBlocks?: number;
  priceFeeds?: readonly string[];
};

export type TickSummary = {
  at: string;
  network: NetworkName;
  tipHeight: number;
  blocks: number;
  reorg: { ancestorHash: string; blocks: number; events: number; activities: number } | null;
  events: number;
  activities: number;
  markets: { written: number; stale: number };
  prices: { written: number; unknown: number };
  reconciliation: { match: number; mismatch: number; unavailable: number };
};

// One pass of the K05 pipeline: evidence first, then projections, then reconciliation.
export async function tick(deps: TickDeps): Promise<TickSummary> {
  const ingested = await ingestBlocks(deps);
  const targets = await listProjectionTargets(deps.sql, deps.network);
  const events = await ingestEvents({ ...deps, targets });

  const block =
    ingested.checkpoint === null ? null : { height: ingested.checkpoint.height, hash: ingested.checkpoint.hash };
  const summary: TickSummary = {
    at: deps.at.toISOString(),
    network: deps.network,
    tipHeight: ingested.tipHeight,
    blocks: ingested.blocks,
    reorg: ingested.reorg,
    events: events.events,
    activities: events.activities,
    markets: { written: 0, stale: 0 },
    prices: { written: 0, unknown: 0 },
    reconciliation: { match: 0, mismatch: 0, unavailable: 0 },
  };

  for (const target of targets) {
    const projected = await latestMarketSnapshot(deps.sql, {
      network: deps.network,
      marketId: target.marketId,
      source: PROJECTION_SOURCE,
    });
    const observed = await projectMarket(deps.hiro, deps.network, target, block, deps.at);
    if (await insertMarketSnapshot(deps.sql, observed)) summary.markets.written += 1;
    if (observed.stale) summary.markets.stale += 1;

    const run = reconciliation(deps.network, target, projected, observed, deps.at);
    await recordReconciliation(deps.sql, run);
    summary.reconciliation[run.status] += 1;
  }

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

  return summary;
}
