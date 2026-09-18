import { Cl, cvToHex } from "@stacks/transactions";
import type { MarketAssets, NetworkName, PositionSnapshotRow, ProjectionTarget } from "@stacks-capital/database";
import { type Hiro, decodeUint, decodeUintList } from "./hiro.ts";
import type { BlockRef } from "./markets.ts";
import { type DecodedPosition, decodePositions, type RewardReading } from "./positions.ts";

// Only a vault exposes a per address balance today. Anything else is reported as unknown, with the reason.
const VAULT_ROLES = new Set(["earn_vault", "debt_vault"]);

export type OwnerReads = { shares: bigint | null; underlying: string | null };

export async function readVaultPosition(hiro: Hiro, contractId: string, owner: string): Promise<OwnerReads> {
  const sender = contractId.split(".")[0] ?? owner;
  const shares = decodeUint(await hiro.callRead(contractId, "get-balance", [cvToHex(Cl.principal(owner))], sender));
  if (shares === null) return { shares: null, underlying: null };
  // The vault itself converts shares into what they are worth, so no rate is guessed here.
  const assets = decodeUint(await hiro.callRead(contractId, "convert-to-assets", [cvToHex(Cl.uint(shares))], sender));
  return { shares, underlying: assets === null ? null : assets.toString(10) };
}

export async function readRewardRate(hiro: Hiro, target: ProjectionTarget): Promise<RewardReading | Error> {
  const sender = target.contractId.split(".")[0] ?? "";
  try {
    const [rates, updated] = await Promise.all([
      hiro.callRead(target.contractId, "get-points-rate", [], sender),
      hiro.callRead(target.contractId, "get-last-update", [], sender),
    ]);
    const schedule = decodeUintList(rates);
    return {
      marketId: target.marketId,
      adapterVersion: target.adapterVersion,
      rate: schedule[0] ?? null,
      updatedAtSeconds: decodeUint(updated),
    };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export type OwnerProjection = { rows: PositionSnapshotRow[]; reads: number };

/** Reads what each market can say about one address, then normalises it (I11). */
export async function projectOwner(
  hiro: Hiro,
  input: {
    network: NetworkName;
    owner: string;
    targets: ProjectionTarget[];
    markets: MarketAssets[];
    at: Date;
    block: BlockRef;
  },
): Promise<OwnerProjection> {
  const positions: DecodedPosition[] = [];
  const underlying = new Map<string, string | null>();
  const read = new Set<string>();
  let reads = 0;

  for (const target of input.targets) {
    if (!VAULT_ROLES.has(target.role)) {
      // No per address read exists for this market, so it is reported as unknown rather than zero.
      positions.push({ owner: input.owner, marketId: target.marketId, kind: "supplied", quantity: "0" });
      continue;
    }
    const result = await readVaultPosition(hiro, target.contractId, input.owner).catch(() => null);
    reads += 1;
    if (result === null || result.shares === null) {
      positions.push({ owner: input.owner, marketId: target.marketId, kind: "supplied", quantity: "0" });
      continue;
    }
    read.add(target.marketId);
    underlying.set(target.marketId, result.underlying);
    positions.push({
      owner: input.owner,
      marketId: target.marketId,
      kind: "supplied",
      quantity: result.shares.toString(10),
    });
  }

  const rows = decodePositions({
    network: input.network,
    positions,
    markets: input.markets,
    reads: { underlyingFor: (marketId) => underlying.get(marketId) ?? null },
    provenance: { stale: false, warnings: [], observedAt: input.at, block: input.block },
    hadRead: (position) => read.has(position.marketId),
  });
  return { rows, reads };
}
