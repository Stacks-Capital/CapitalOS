import type { CanonicalObservation, CashFlowEvent, ShareRate, UnclaimedReward } from "@stacks-capital/core";
import type { Sql } from "./lib.ts";
import type { NetworkName } from "./registry.ts";

export type EarnPerformanceMarketData = {
  marketId: string;
  assetId: string;
  receiptAssetId: string | null;
  currentPositionShares: string | null;
  currentUnderlyingUnits: string | null;
  currentShareRate: ShareRate | null;
  initialShareRate: ShareRate | null;
  marketSupplyRateBps: string | null;
  marketRateScale: number | null;
  marketRateStale: boolean;
  reconciliationStatus: "match" | "mismatch" | "unavailable" | null;
  cashFlows: CashFlowEvent[];
  unclaimedRewards: UnclaimedReward[];
  observations: CanonicalObservation[];
};

/**
 * Gathers all canonical performance, cash-flow, rate, and observation data for an owner.
 */
export async function getEarnPerformanceData(
  sql: Sql,
  network: NetworkName,
  owner: string,
  marketId?: string,
): Promise<EarnPerformanceMarketData[]> {
  // Query target markets
  const markets = await sql<{ id: string; suppliedAssetId: string | null; receiptAssetId: string | null }[]>`
    SELECT id, supplied_asset_id AS "suppliedAssetId", receipt_asset_id AS "receiptAssetId"
    FROM markets
    WHERE network = ${network}
      ${marketId !== undefined ? sql`AND id = ${marketId}` : sql``}
    ORDER BY id
  `;

  if (markets.length === 0) return [];

  const results: EarnPerformanceMarketData[] = [];

  for (const m of markets) {
    const assetId = m.suppliedAssetId ?? "sbtc:sbtc-token";

    // 1. Completed workflows for cash flows
    const workflowRows = await sql<
      {
        id: string;
        action: string;
        input: { asset: string; quantity: string }[];
        expectedOutput: { asset: string; quantity: string }[];
        fees: { kind: string; amount: { asset: string; quantity: string } }[];
        createdAt: Date;
      }[]
    >`
      SELECT w.id, q.action, q.input, q.expected_output AS "expectedOutput", q.fees, w.created_at AS "createdAt"
      FROM workflows w
      JOIN quotes q ON q.id = w.quote_id AND q.network = w.network
      WHERE w.network = ${network}
        AND w.owner_address = ${owner}
        AND q.market_id = ${m.id}
        AND w.state = 'COMPLETED'
      ORDER BY w.created_at ASC
    `;

    const cashFlows: CashFlowEvent[] = [];
    for (const w of workflowRows) {
      const ts = w.createdAt.toISOString();
      if (w.action === "supply") {
        const depositAmt = w.input[0]?.quantity ?? "0";
        cashFlows.push({
          id: `${w.id}:deposit`,
          kind: "deposit",
          assetId,
          amount: depositAmt,
          timestamp: ts,
        });
      } else if (w.action === "withdraw_supply" || w.action === "redeem") {
        const withdrawAmt = w.expectedOutput[0]?.quantity ?? "0";
        cashFlows.push({
          id: `${w.id}:withdrawal`,
          kind: "withdrawal",
          assetId,
          amount: withdrawAmt,
          timestamp: ts,
        });
      }
      for (let i = 0; i < (w.fees ?? []).length; i++) {
        const f = w.fees[i];
        if (f?.amount) {
          cashFlows.push({
            id: `${w.id}:fee:${i}`,
            kind: "fee",
            assetId: f.amount.asset,
            amount: f.amount.quantity,
            timestamp: ts,
          });
        }
      }
    }

    // 2. Canonical position observations
    const positionRows = await sql<
      {
        quantity: string | null;
        observedAt: Date;
        blockHeight: number | null;
        blockHash: string | null;
        source: string;
      }[]
    >`
      SELECT quantity, observed_at AS "observedAt", block_height::int AS "blockHeight", block_hash AS "blockHash", source
      FROM position_snapshots
      WHERE network = ${network}
        AND owner = ${owner}
        AND market_id = ${m.id}
        AND kind IN ('supplied', 'wallet')
      ORDER BY observed_at ASC, id ASC
    `;

    // 3. Market snapshots (rates & share rates)
    const marketSnapshotRows = await sql<
      {
        supplyRate: string | null;
        rateScale: number | null;
        stale: boolean;
        observedAt: Date;
        blockHeight: number | null;
        blockHash: string | null;
        source: string;
      }[]
    >`
      SELECT supply_rate::text AS "supplyRate", rate_scale::int AS "rateScale", stale,
             observed_at AS "observedAt", block_height::int AS "blockHeight", block_hash AS "blockHash", source
      FROM market_snapshots
      WHERE network = ${network}
        AND market_id = ${m.id}
      ORDER BY observed_at ASC, id ASC
    `;

    // 4. Reward snapshots for this owner and market
    const rewardRows = await sql<
      {
        kind: string;
        accrued: string | null;
        accruedAssetId: string | null;
        observedAt: Date;
      }[]
    >`
      SELECT kind, accrued, accrued_asset_id AS "accruedAssetId", observed_at AS "observedAt"
      FROM reward_snapshots
      WHERE network = ${network}
        AND market_id = ${m.id}
        AND (owner = ${owner} OR owner IS NULL)
      ORDER BY observed_at ASC, id ASC
    `;

    // 5. Latest reconciliation status
    const reconRow = await sql<{ status: string | null }[]>`
      SELECT status
      FROM reconciliation_runs
      WHERE network = ${network}
        AND market_id = ${m.id}
      ORDER BY run_at DESC, id DESC
      LIMIT 1
    `;

    // Latest market snapshot
    const latestMarketSnap = marketSnapshotRows[marketSnapshotRows.length - 1];
    const marketSupplyRateBps = latestMarketSnap?.supplyRate ?? null;
    const marketRateScale = latestMarketSnap?.rateScale ?? null;
    const marketRateStale = latestMarketSnap?.stale ?? true;

    // Unclaimed rewards
    const unclaimedRewards: UnclaimedReward[] = [];
    for (const r of rewardRows) {
      if (r.kind === "accrual" && r.accrued && r.accruedAssetId) {
        unclaimedRewards.push({
          assetId: r.accruedAssetId,
          amount: r.accrued,
          usdValue: null,
          observedAt: r.observedAt.toISOString(),
        });
      }
    }

    // Compose observations for chart:
    // A point represents a canonical observation snapshot with observedAt, source, blockHeight, etc.
    const observations: CanonicalObservation[] = [];
    for (const pos of positionRows) {
      observations.push({
        observedAt: pos.observedAt.toISOString(),
        blockHeight: pos.blockHeight,
        blockHash: pos.blockHash,
        source: pos.source,
        positionShares: pos.quantity,
        underlyingValue: pos.quantity, // will be converted via share rate if available
      });
    }

    // Current position
    const latestPos = positionRows[positionRows.length - 1];
    const currentPositionShares = latestPos?.quantity ?? null;
    const currentUnderlyingUnits = latestPos?.quantity ?? null;

    results.push({
      marketId: m.id,
      assetId,
      receiptAssetId: m.receiptAssetId,
      currentPositionShares,
      currentUnderlyingUnits,
      currentShareRate: null, // default 1:1 if not multi-tiered share rate
      initialShareRate: null,
      marketSupplyRateBps,
      marketRateScale,
      marketRateStale,
      reconciliationStatus: (reconRow[0]?.status as "match" | "mismatch" | "unavailable") ?? null,
      cashFlows,
      unclaimedRewards,
      observations,
    });
  }

  return results;
}
