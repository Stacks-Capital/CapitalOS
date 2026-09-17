import type { MarketSnapshotRow, NetworkName, ProjectionTarget, ReconciliationRow } from "@stacks-capital/database";
import { type Hiro, decodeTuple, decodeUint, tupleBool } from "./hiro.ts";

export const CALCULATION_VERSION = "market-projection@0.1.0";
export const PROJECTION_SOURCE = "hiro-read";
// Vault rates and utilization come back in basis points: value / 10^4.
export const RATE_SCALE = 4;

// Roles whose contract exposes the vault read surface. Anything else is projected as unknown, with a warning.
const VAULT_ROLES = new Set(["earn_vault", "debt_vault"]);

export type VaultReads = {
  totalAssets: bigint | null;
  availableAssets: bigint | null;
  capSupply: bigint | null;
  interestRate: bigint | null;
  pausedDeposit: boolean | null;
  pausedRedeem: boolean | null;
};

export type BlockRef = { height: number; hash: string } | null;

export async function readVault(hiro: Hiro, contractId: string): Promise<VaultReads> {
  const sender = contractId.split(".")[0] ?? "";
  const [total, available, cap, rate, pause] = await Promise.all([
    hiro.callRead(contractId, "get-total-assets", [], sender),
    hiro.callRead(contractId, "get-available-assets", [], sender),
    hiro.callRead(contractId, "get-cap-supply", [], sender),
    hiro.callRead(contractId, "get-interest-rate", [], sender),
    hiro.callRead(contractId, "get-pause-states", [], sender),
  ]);
  const pauseStates = decodeTuple(pause);
  return {
    totalAssets: decodeUint(total),
    availableAssets: decodeUint(available),
    capSupply: decodeUint(cap),
    interestRate: decodeUint(rate),
    pausedDeposit: tupleBool(pauseStates, "deposit"),
    pausedRedeem: tupleBool(pauseStates, "redeem"),
  };
}

function quantity(value: bigint | null): string | null {
  return value === null || value < 0n ? null : value.toString(10);
}

export function marketSnapshot(
  network: NetworkName,
  target: ProjectionTarget,
  reads: VaultReads | Error | null,
  block: BlockRef,
  at: Date,
): MarketSnapshotRow {
  const base = {
    network,
    marketId: target.marketId,
    source: PROJECTION_SOURCE,
    observedAt: at,
    blockHeight: block?.height ?? null,
    blockHash: block?.hash ?? null,
    adapterVersion: target.adapterVersion,
    calculationVersion: CALCULATION_VERSION,
  };
  const unknown = (warning: string): MarketSnapshotRow => ({
    ...base,
    supplyRate: null,
    borrowRate: null,
    rateScale: null,
    availableLiquidity: null,
    capacity: null,
    paused: null,
    stale: true,
    warnings: [warning],
  });

  if (reads instanceof Error) return unknown(`${target.marketId} read failed: ${reads.message}`);
  if (reads === null) return unknown(`${target.marketId} has no onchain read for role ${target.role}`);

  const availableLiquidity = quantity(reads.availableAssets);
  const capacity = quantity(reads.capSupply);
  const supplyRate = reads.interestRate === null ? null : reads.interestRate.toString(10);
  const warnings: string[] = [];
  if (availableLiquidity === null) warnings.push(`${target.marketId} available liquidity is unknown`);
  if (capacity === null) warnings.push(`${target.marketId} supply cap is unknown`);
  if (supplyRate === null) warnings.push(`${target.marketId} supply rate is unknown`);
  const paused =
    reads.pausedDeposit === null && reads.pausedRedeem === null
      ? null
      : reads.pausedDeposit === true || reads.pausedRedeem === true;
  if (paused === null) warnings.push(`${target.marketId} pause state is unknown`);

  return {
    ...base,
    supplyRate,
    borrowRate: null,
    rateScale: supplyRate === null ? null : RATE_SCALE,
    availableLiquidity,
    capacity,
    paused,
    // A snapshot missing any field is not trusted for pricing or sizing, so it is served as stale.
    stale: warnings.length > 0,
    warnings,
  };
}

export async function projectMarket(
  hiro: Hiro,
  network: NetworkName,
  target: ProjectionTarget,
  block: BlockRef,
  at: Date,
): Promise<MarketSnapshotRow> {
  if (!VAULT_ROLES.has(target.role)) return marketSnapshot(network, target, null, block, at);
  const reads = await readVault(hiro, target.contractId).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  return marketSnapshot(network, target, reads, block, at);
}

// Step 5 of the K05 pipeline: what the projection holds is compared with a direct read of the same contract.
export function reconciliation(
  network: NetworkName,
  target: ProjectionTarget,
  projected: MarketSnapshotRow | null,
  observed: MarketSnapshotRow,
  at: Date,
): ReconciliationRow {
  const base = { network, marketId: target.marketId, source: PROJECTION_SOURCE, runAt: at };
  if (projected === null || projected.availableLiquidity === null || observed.availableLiquidity === null) {
    return {
      ...base,
      status: "unavailable",
      detail: `${target.marketId} has no comparable liquidity value`,
      projected: null,
      observed: null,
    };
  }
  const same = projected.availableLiquidity === observed.availableLiquidity && projected.capacity === observed.capacity;
  return {
    ...base,
    status: same ? "match" : "mismatch",
    detail: same
      ? `${target.marketId} matches the direct read`
      : `${target.marketId} projected ${projected.availableLiquidity}/${projected.capacity}, read ${observed.availableLiquidity}/${observed.capacity}`,
    projected: same
      ? null
      : {
          availableLiquidity: projected.availableLiquidity,
          capacity: projected.capacity,
          observedAt: projected.observedAt,
        },
    observed: same
      ? null
      : {
          availableLiquidity: observed.availableLiquidity,
          capacity: observed.capacity,
          observedAt: observed.observedAt,
        },
  };
}
