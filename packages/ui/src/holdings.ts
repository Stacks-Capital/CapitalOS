import type { Market } from "@stacks-capital/client";
import {
  type AccountingEntry,
  type AssetValuation,
  type CapitalCategory,
  type LinkedCollateralRef,
  type PortfolioAccountingSummary,
  evaluatePortfolioAccounting,
  normalizeCapitalCategory,
} from "@stacks-capital/core";

export type { CapitalCategory, LinkedCollateralRef } from "@stacks-capital/core";

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
  kind: "supplied" | "debt" | "collateral" | "lp" | "locked" | "staked" | "wallet";
  assetId: string;
  quantity: string | null;
  stale: boolean;
  warnings: string[];
  protocolKey?: string;
  linkedCollateral?: LinkedCollateralRef | null;
};

export type RowKind = CapitalCategory | "receipt";

export type PortfolioRow = {
  key: string;
  kind: RowKind;
  category?: CapitalCategory | null;
  assetId: string;
  quantity: string | null;
  marketId: string | null;
  protocolKey?: string | null;
  /** False for anything already represented by another row, so a total never counts it twice. */
  countsTowardTotal: boolean;
  /** Linked backing collateral reference for debt rows. */
  linkedCollateral?: LinkedCollateralRef | null;
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

export type Portfolio = {
  rows: PortfolioRow[];
  totals: PortfolioTotal[];
};

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
        category: "wallet",
        assetId: balance.assetId,
        quantity: balance.quantity,
        marketId: null,
        protocolKey: null,
        countsTowardTotal: true,
        linkedCollateral: null,
        stale: balance.stale,
        warnings: balance.warnings,
      });
      continue;
    }

    const covered = suppliedMarkets.has(receipt.marketId);
    rows.push({
      key: `receipt:${balance.assetId}`,
      kind: "receipt",
      category: null,
      assetId: balance.assetId,
      quantity: balance.quantity,
      marketId: receipt.marketId,
      protocolKey: null,
      // Receipt units are not underlying units, so a receipt never adds to a total on its own.
      countsTowardTotal: false,
      linkedCollateral: null,
      stale: balance.stale,
      warnings: [
        ...balance.warnings,
        covered
          ? `Shown by the ${receipt.marketId} position, not counted again`
          : `Receipt for ${receipt.marketId}. Its underlying value needs the vault share rate`,
      ],
    });
  }

  // Find collateral positions by market for linking debt
  const collateralByMarket = new Map<string, Position>();
  for (const pos of input.positions) {
    if (pos.kind === "collateral") {
      collateralByMarket.set(pos.marketId, pos);
    }
  }

  for (const position of input.positions) {
    const category = normalizeCapitalCategory(position.kind) ?? "supplied";
    const isDebt = category === "debt";

    let linkedCollateral: LinkedCollateralRef | null = position.linkedCollateral ?? null;
    const warnings = [...position.warnings];

    if (isDebt && !linkedCollateral) {
      const backing = collateralByMarket.get(position.marketId);
      if (backing) {
        linkedCollateral = {
          marketId: backing.marketId,
          assetId: backing.assetId,
          protocolKey: backing.protocolKey ?? undefined,
          quantity: backing.quantity ?? null,
        };
      } else {
        warnings.push(`Debt in ${position.marketId} has no visible collateral position`);
      }
    }

    rows.push({
      key: `${category}:${position.marketId}:${position.assetId}`,
      kind: category,
      category,
      assetId: position.assetId,
      quantity: position.quantity,
      marketId: position.marketId,
      protocolKey: position.protocolKey ?? null,
      countsTowardTotal: position.kind !== "debt",
      linkedCollateral,
      stale: position.stale,
      warnings,
    });
  }

  const assetRows = rows.filter((r) => r.countsTowardTotal);
  const totals = totalsFor(assetRows);

  return {
    rows,
    totals,
  };
}

export function computePortfolioTotals(rows: PortfolioRow[]): {
  assetTotals: PortfolioTotal[];
  debtTotals: PortfolioTotal[];
  netTotals: PortfolioTotal[];
  byCategoryTotals: Record<CapitalCategory, PortfolioTotal[]>;
} {
  const assetRows = rows.filter((r) => r.countsTowardTotal && r.category !== null && r.category !== "debt");
  const debtRows = rows.filter((r) => r.category === "debt");

  const assetTotals = totalsFor(assetRows);
  const debtTotals = totalsFor(debtRows.map((r) => ({ ...r, countsTowardTotal: true })));
  const netTotals = computeNetTotals(assetTotals, debtTotals);

  const byCategoryTotals: Record<CapitalCategory, PortfolioTotal[]> = {
    wallet: totalsFor(rows.filter((r) => r.category === "wallet")),
    supplied: totalsFor(rows.filter((r) => r.category === "supplied")),
    lp: totalsFor(rows.filter((r) => r.category === "lp")),
    collateral: totalsFor(rows.filter((r) => r.category === "collateral")),
    debt: totalsFor(debtRows.map((r) => ({ ...r, countsTowardTotal: true }))),
    locked: totalsFor(rows.filter((r) => r.category === "locked")),
  };

  return { assetTotals, debtTotals, netTotals, byCategoryTotals };
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

function computeNetTotals(assets: PortfolioTotal[], debts: PortfolioTotal[]): PortfolioTotal[] {
  const allAssetIds = new Set([...assets.map((a) => a.assetId), ...debts.map((d) => d.assetId)]);
  const assetMap = new Map(assets.map((a) => [a.assetId, a]));
  const debtMap = new Map(debts.map((d) => [d.assetId, d]));
  const results: PortfolioTotal[] = [];

  for (const assetId of allAssetIds) {
    const a = assetMap.get(assetId);
    const d = debtMap.get(assetId);

    const incomplete = (a?.incomplete ?? false) || (d?.incomplete ?? false);
    const warnings = [...(a?.warnings ?? []), ...(d?.warnings ?? [])];

    if (a?.quantity === null || d?.quantity === null) {
      results.push({ assetId, quantity: null, incomplete: true, warnings });
      continue;
    }

    const aQty = a ? BigInt(a.quantity) : 0n;
    const dQty = d ? BigInt(d.quantity) : 0n;
    const net = aQty - dQty;

    results.push({
      assetId,
      quantity: net.toString(10),
      incomplete,
      warnings,
    });
  }

  return results.sort((left, right) => (left.assetId < right.assetId ? -1 : 1));
}

/**
 * The rows a total deliberately leaves out, each with the reason. The partial state has to name these,
 * because a subtotal that quietly drops positions reads as a complete balance.
 */
export function excludedFrom(portfolio: Portfolio): Array<{ name: string; reason: string }> {
  const excluded: Array<{ name: string; reason: string }> = [];
  for (const row of portfolio.rows) {
    const name = row.marketId === null ? row.assetId : `${row.assetId} in ${row.marketId}`;
    if (!row.countsTowardTotal) {
      excluded.push({ name, reason: "already counted through the protocol position it represents" });
    } else if (row.quantity === null) {
      excluded.push({ name, reason: "the provider returned no quantity, and zero is a real balance" });
    }
  }
  return excluded;
}

export type ValuedPortfolio = PortfolioAccountingSummary & {
  /** Legacy alias: equals netWorthUsd if valued, otherwise grossAssetsUsd. */
  totalUsd: string | null;
};

/**
 * Values the portfolio against oracle valuations.
 * Enforces:
 * 1. Normalized capital categories (wallet, supplied, lp, collateral, debt, locked).
 * 2. Deduplication of receipt tokens.
 * 3. Exact Net = Gross Assets - Gross Debt.
 * 4. Transparent coverage disclosure without withholding unrelated verified values.
 */
export function valuePortfolio(portfolio: Portfolio, valuations: AssetValuation[]): ValuedPortfolio {
  const entries: AccountingEntry[] = portfolio.rows.map((row) => ({
    id: row.key,
    category: row.category ?? "wallet",
    assetId: row.assetId,
    quantity: row.quantity,
    marketId: row.marketId,
    protocolKey: row.protocolKey ?? null,
    isReceipt: row.kind === "receipt",
    countsTowardTotal: row.kind !== "receipt",
    linkedCollateral: row.linkedCollateral ?? null,
    stale: row.stale,
    warnings: row.warnings,
  }));

  const summary = evaluatePortfolioAccounting(entries, valuations);
  return {
    ...summary,
    totalUsd: summary.netWorthUsd ?? summary.grossAssetsUsd,
  };
}
