import type { Market } from "@stacks-capital/client";

/** A token balance held by the wallet itself. */
export type Balance = {
  assetId: string;
  quantity: string | null;
  stale: boolean;
  warnings: string[];
};

/** What a protocol reports for this address, in underlying units. */
export type Position = {
  marketId: string;
  kind: "supplied" | "debt" | "collateral";
  assetId: string;
  quantity: string | null;
  stale: boolean;
  warnings: string[];
};

export type RowKind = "wallet" | "supplied" | "debt" | "collateral" | "receipt";

export type PortfolioRow = {
  key: string;
  kind: RowKind;
  assetId: string;
  quantity: string | null;
  marketId: string | null;
  /** False for anything already represented by another row, so a total never counts it twice. */
  countsTowardTotal: boolean;
  stale: boolean;
  warnings: string[];
};

export type PortfolioTotal = {
  assetId: string;
  quantity: string | null;
  /** True when a row that should count had no value, so the total cannot be trusted. */
  incomplete: boolean;
  warnings: string[];
};

export type Portfolio = { rows: PortfolioRow[]; totals: PortfolioTotal[] };

type ReceiptLink = { marketId: string; underlyingAssetId: string | null };

function receiptIndex(markets: Market[]): Map<string, ReceiptLink> {
  const index = new Map<string, ReceiptLink>();
  for (const market of markets) {
    if (market.receiptAssetId === null) continue;
    index.set(market.receiptAssetId, { marketId: market.id, underlyingAssetId: market.suppliedAssetId });
  }
  return index;
}

/**
 * A vault receipt and the position it represents are the same money. Counting both would double it,
 * so the protocol reported position counts and the receipt balance is shown as evidence only.
 */
export function buildPortfolio(input: { balances: Balance[]; positions: Position[]; markets: Market[] }): Portfolio {
  const receipts = receiptIndex(input.markets);
  const suppliedMarkets = new Set(
    input.positions.filter((position) => position.kind === "supplied").map((position) => position.marketId),
  );
  const rows: PortfolioRow[] = [];

  for (const balance of input.balances) {
    const receipt = receipts.get(balance.assetId);
    if (receipt === undefined) {
      rows.push({
        key: `wallet:${balance.assetId}`,
        kind: "wallet",
        assetId: balance.assetId,
        quantity: balance.quantity,
        marketId: null,
        countsTowardTotal: true,
        stale: balance.stale,
        warnings: balance.warnings,
      });
      continue;
    }

    const covered = suppliedMarkets.has(receipt.marketId);
    rows.push({
      key: `receipt:${balance.assetId}`,
      kind: "receipt",
      assetId: balance.assetId,
      quantity: balance.quantity,
      marketId: receipt.marketId,
      // Receipt units are not underlying units, so a receipt never adds to a total on its own.
      countsTowardTotal: false,
      stale: balance.stale,
      warnings: [
        ...balance.warnings,
        covered
          ? `Shown by the ${receipt.marketId} position, not counted again`
          : `Receipt for ${receipt.marketId}. Its underlying value needs the vault share rate`,
      ],
    });
  }

  for (const position of input.positions) {
    rows.push({
      key: `${position.kind}:${position.marketId}:${position.assetId}`,
      kind: position.kind,
      assetId: position.assetId,
      quantity: position.quantity,
      marketId: position.marketId,
      countsTowardTotal: position.kind !== "debt",
      stale: position.stale,
      warnings: position.warnings,
    });
  }

  return { rows, totals: totalsFor(rows) };
}

function totalsFor(rows: PortfolioRow[]): PortfolioTotal[] {
  const totals = new Map<string, PortfolioTotal>();
  for (const row of rows) {
    if (!row.countsTowardTotal) continue;
    const running = totals.get(row.assetId) ?? { assetId: row.assetId, quantity: "0", incomplete: false, warnings: [] };
    if (row.quantity === null) {
      // One unknown part makes the whole total unknown. A missing value is never treated as zero.
      totals.set(row.assetId, {
        assetId: row.assetId,
        quantity: null,
        incomplete: true,
        warnings: [...running.warnings, ...row.warnings],
      });
      continue;
    }
    totals.set(row.assetId, {
      assetId: row.assetId,
      quantity: running.quantity === null ? null : (BigInt(running.quantity) + BigInt(row.quantity)).toString(10),
      incomplete: running.incomplete,
      warnings: [...running.warnings, ...row.warnings],
    });
  }
  return [...totals.values()].sort((left, right) => (left.assetId < right.assetId ? -1 : 1));
}
