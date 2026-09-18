import type {
  MarketAssets,
  NetworkName,
  PositionKind,
  PositionSnapshotRow,
  RewardSnapshotRow,
} from "@stacks-capital/database";
import type { BlockRef } from "./markets.ts";

export const POSITION_SOURCE = "hiro-read";
export const POSITION_CALCULATION = "position-decoder@0.1.0";
export const REWARD_CALCULATION = "reward-projection@0.1.0";
export const REWARD_SCALE = 4;

/** What each protocol calls a position, and what it means in our terms. */
const KINDS: Record<string, PositionKind> = {
  supplied: "supplied",
  supply: "supplied",
  collateral: "collateral",
  debt: "debt",
  borrow: "debt",
  staked: "staked",
  pending_deposit: "pending_deposit",
  pending_withdrawal: "pending_withdrawal",
  wallet: "wallet",
};

export type DecodedPosition = { owner: string; marketId: string; kind: string; quantity: string };

export type PositionReads = {
  /** Underlying value of a receipt balance, when the vault could be asked. */
  underlyingFor?: (marketId: string, shares: string) => string | null;
};

/**
 * Turns what an adapter reported into rows the platform can trust.
 *
 * Two rules matter here. A receipt balance is converted to its underlying with the vault's share rate,
 * because receipt units and underlying units are not the same money (I09). And a quantity the adapter
 * defaulted to zero when it had no read is stored as unknown, because zero is a real balance.
 */
export function decodePositions(input: {
  network: NetworkName;
  positions: DecodedPosition[];
  markets: MarketAssets[];
  reads: PositionReads;
  provenance: { stale: boolean; warnings: string[]; source?: string; observedAt: Date; block: BlockRef };
  hadRead: (position: DecodedPosition) => boolean;
}): PositionSnapshotRow[] {
  const byMarket = new Map(input.markets.map((market) => [market.marketId, market]));
  const rows: PositionSnapshotRow[] = [];

  for (const position of input.positions) {
    const market = byMarket.get(position.marketId);
    if (market === undefined) continue;

    const kind = KINDS[position.kind];
    const base = {
      owner: position.owner,
      network: input.network,
      deploymentId: market.deploymentId,
      marketId: market.marketId,
      protocolKey: `${market.marketId}:${position.kind}`,
      source: input.provenance.source ?? POSITION_SOURCE,
      observedAt: input.provenance.observedAt,
      blockHeight: input.provenance.block?.height ?? null,
      blockHash: input.provenance.block?.hash ?? null,
      adapterVersion: market.adapterVersion,
      calculationVersion: POSITION_CALCULATION,
    };

    // An unknown kind is never guessed into a known one.
    if (kind === undefined) {
      const assetId = market.suppliedAssetId ?? market.receiptAssetId;
      if (assetId === null) continue;
      rows.push({
        ...base,
        kind: "wallet",
        assetId,
        quantity: null,
        stale: true,
        warnings: [`${market.marketId} reported an unknown position kind: ${position.kind}`],
      });
      continue;
    }

    const warnings = [...input.provenance.warnings];
    let quantity: string | null = position.quantity;
    let assetId = kind === "debt" ? market.suppliedAssetId : (market.suppliedAssetId ?? market.receiptAssetId);

    // The adapter fills a missing read with "0". Zero and unknown are different answers.
    if (!input.hadRead(position)) {
      quantity = null;
      warnings.push(`${market.marketId} ${position.kind} was not read, so it is unknown`);
    } else if (kind === "supplied" && market.receiptAssetId !== null) {
      // A supplied balance arrives in receipt shares. Only the vault can say what they are worth.
      const underlying = input.reads.underlyingFor?.(market.marketId, position.quantity) ?? null;
      if (underlying === null) {
        assetId = market.receiptAssetId;
        warnings.push(`${market.marketId} is held in receipt units; the share rate was unavailable`);
      } else {
        quantity = underlying;
        assetId = market.suppliedAssetId ?? market.receiptAssetId;
      }
    }

    if (assetId === null) continue;
    rows.push({ ...base, kind, assetId, quantity, stale: input.provenance.stale || quantity === null, warnings });
  }

  return rows;
}

/**
 * Sources report time in their own unit: the vault in seconds, the oracle in milliseconds.
 * Everything is normalised to a real instant, and a value that cannot be read is null with a warning.
 */
export function normalizeTimestamp(value: bigint | number | null, unit: "seconds" | "milliseconds"): Date | null {
  if (value === null) return null;
  const raw = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = unit === "seconds" ? raw * 1000 : raw;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at;
}

export type RewardReading = {
  marketId: string;
  adapterVersion: string;
  /** Basis points, as the vault reports them. */
  rate: bigint | null;
  updatedAtSeconds: bigint | null;
};

export function rewardSnapshot(
  network: NetworkName,
  reading: RewardReading | Error,
  marketId: string,
  adapterVersion: string,
  at: Date,
  block: BlockRef,
  maxAgeMs = 24 * 60 * 60 * 1000,
): RewardSnapshotRow {
  const base = {
    network,
    marketId,
    owner: null,
    kind: "rate" as const,
    accrued: null,
    accruedAssetId: null,
    source: POSITION_SOURCE,
    observedAt: at,
    blockHeight: block?.height ?? null,
    blockHash: block?.hash ?? null,
    adapterVersion,
    calculationVersion: REWARD_CALCULATION,
  };

  if (reading instanceof Error) {
    return {
      ...base,
      rate: null,
      rateScale: null,
      updatedAt: null,
      stale: true,
      warnings: [`${marketId} reward read failed: ${reading.message}`],
    };
  }

  const updatedAt = normalizeTimestamp(reading.updatedAtSeconds, "seconds");
  const warnings: string[] = [];
  if (reading.rate === null) warnings.push(`${marketId} reward rate is unknown`);
  if (updatedAt === null) warnings.push(`${marketId} did not report when its rate was last updated`);

  const ageMs = updatedAt === null ? Number.POSITIVE_INFINITY : at.getTime() - updatedAt.getTime();
  const old = ageMs > maxAgeMs;
  if (old && updatedAt !== null)
    warnings.push(`${marketId} rate was last updated ${Math.round(ageMs / 3_600_000)} hours ago`);

  return {
    ...base,
    rate: reading.rate === null ? null : reading.rate.toString(10),
    rateScale: reading.rate === null ? null : REWARD_SCALE,
    updatedAt,
    stale: reading.rate === null || old,
    warnings,
  };
}
