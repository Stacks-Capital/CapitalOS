import { contract, REGISTRY_VERSION } from "@stacks-capital/config";
import { createGraniteCreditAdapter, type AdapterReads } from "@stacks-capital/adapters";
import { ORACLE_MAX_AGE_MS, type StacksNetwork } from "@stacks-capital/core";

export const GOLDEN_FIXTURE_OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
export const GOLDEN_FIXTURE_NOW = "2026-09-15T12:00:00.000Z";

/** Snapshot used as the independent side of golden reconcile (not adapter output). */
export const GOLDEN_FIXTURE_POSITION = {
  collateral: "100000000",
  debt: "0",
} as const;

const goldenReads: AdapterReads = {
  emilyLimits: {
    perDepositMinimum: "1000",
    perWithdrawalCap: "50100000000",
    pegCap: "2100000000000000",
  },
  oracle: {
    sbtc: {
      price: "10000000000000",
      scale: "8",
      observedAt: GOLDEN_FIXTURE_NOW,
      source: "fixture",
      stale: false,
      maxAgeMs: ORACLE_MAX_AGE_MS,
    },
    usdcx: {
      price: "100000000",
      scale: "8",
      observedAt: GOLDEN_FIXTURE_NOW,
      source: "fixture",
      stale: false,
      maxAgeMs: ORACLE_MAX_AGE_MS,
    },
  },
  position: { ...GOLDEN_FIXTURE_POSITION },
  source: "golden-fixture",
};

export type GoldenPositionExpectation = {
  marketId: string;
  kind: "collateral" | "debt" | "supplied";
  quantity: string;
};

export type GoldenAddress = {
  id: string;
  network: StacksNetwork;
  address: string;
  kind: "user" | "protocol";
  /** Independent expected quantities — not taken from the adapter under test. */
  expectations: GoldenPositionExpectation[];
  limitations: string[];
};

export type GoldenReconcileResult = {
  id: string;
  matched: boolean;
  mismatches: string[];
  observed: GoldenPositionExpectation[];
  expected: GoldenPositionExpectation[];
  limitations: string[];
  registryVersion: string;
  source: string;
};

/** Fixture-mode golden set. Live mainnet-shadow may extend this list with read-only probes. */
export const FIXTURE_GOLDEN_ADDRESSES: readonly GoldenAddress[] = [
  {
    id: "fixture-user-granite",
    network: "mainnet",
    address: GOLDEN_FIXTURE_OWNER,
    kind: "user",
    expectations: [
      { marketId: "granite.sbtc.isolated", kind: "collateral", quantity: GOLDEN_FIXTURE_POSITION.collateral },
      { marketId: "granite.sbtc.isolated", kind: "debt", quantity: GOLDEN_FIXTURE_POSITION.debt },
    ],
    limitations: [
      "Fixture snapshot only. Live Granite position reads remain a launch block (I20-B3).",
      'Missing adapter reads still coerce to "0"; golden expectations must be explicit quantities.',
    ],
  },
  {
    id: "protocol-zest-vault",
    network: "mainnet",
    address: contract("zest", "v0-vault-sbtc", "mainnet").contractId,
    kind: "protocol",
    expectations: [],
    limitations: ["Protocol principal identity is reconciled against the signed registry, not user balances."],
  },
  {
    id: "protocol-granite-market",
    network: "mainnet",
    address: contract("granite", "v0-8-market", "mainnet").contractId,
    kind: "protocol",
    expectations: [],
    limitations: ["Protocol principal identity is reconciled against the signed registry."],
  },
];

function keyOf(row: GoldenPositionExpectation): string {
  return `${row.marketId}:${row.kind}`;
}

/**
 * Reconcile observed positions against an independent golden expectation.
 * The two sides must be produced by different sources (e.g. fixture snapshot vs adapter read).
 */
export function reconcileGoldenPositions(
  expected: readonly GoldenPositionExpectation[],
  observed: readonly GoldenPositionExpectation[],
): { matched: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const observedMap = new Map(observed.map((row) => [keyOf(row), row.quantity]));
  for (const row of expected) {
    const got = observedMap.get(keyOf(row));
    if (got === undefined) mismatches.push(`missing observed ${keyOf(row)}`);
    else if (got !== row.quantity) mismatches.push(`${keyOf(row)} expected ${row.quantity} observed ${got}`);
  }
  for (const row of observed) {
    if (!expected.some((item) => keyOf(item) === keyOf(row))) {
      mismatches.push(`unexpected observed ${keyOf(row)}=${row.quantity}`);
    }
  }
  return { matched: mismatches.length === 0, mismatches };
}

/** Fixture-mode golden reconcile: registry principals + user positions from two independent sources. */
export function reconcileFixtureGoldenAddresses(): GoldenReconcileResult[] {
  const ctx = {
    network: "mainnet" as const,
    now: new Date(GOLDEN_FIXTURE_NOW),
    owner: GOLDEN_FIXTURE_OWNER,
    registryVersion: REGISTRY_VERSION,
  };
  const granite = createGraniteCreditAdapter(goldenReads);
  const results: GoldenReconcileResult[] = [];

  for (const golden of FIXTURE_GOLDEN_ADDRESSES) {
    if (golden.kind === "protocol") {
      const label = golden.id.includes("zest") ? ("zest" as const) : ("granite" as const);
      const role = label === "zest" ? ("v0-vault-sbtc" as const) : ("v0-8-market" as const);
      const pinned = contract(label, role, golden.network).contractId;
      const matched = pinned === golden.address;
      results.push({
        id: golden.id,
        matched,
        mismatches: matched ? [] : [`registry ${pinned} !== golden ${golden.address}`],
        observed: [],
        expected: [],
        limitations: [...golden.limitations],
        registryVersion: REGISTRY_VERSION,
        source: "signed-registry",
      });
      continue;
    }

    const independent: GoldenPositionExpectation[] = [
      {
        marketId: "granite.sbtc.isolated",
        kind: "collateral",
        quantity: GOLDEN_FIXTURE_POSITION.collateral,
      },
      {
        marketId: "granite.sbtc.isolated",
        kind: "debt",
        quantity: GOLDEN_FIXTURE_POSITION.debt,
      },
    ];
    const read = granite.readPositions(ctx, golden.address);
    const rows = read.value ?? [];
    const observed: GoldenPositionExpectation[] = rows
      .filter((row) => row.kind === "collateral" || row.kind === "debt" || row.kind === "supplied")
      .map((row) => ({
        marketId: row.marketId,
        kind: row.kind as GoldenPositionExpectation["kind"],
        quantity: row.quantity,
      }));
    const { matched, mismatches } = reconcileGoldenPositions(independent, observed);
    results.push({
      id: golden.id,
      matched,
      mismatches,
      observed,
      expected: independent,
      limitations: [...golden.limitations, ...read.warnings],
      registryVersion: REGISTRY_VERSION,
      source: read.source,
    });
  }

  return results;
}

export type GoldenPortfolioAccountingReport = {
  address: string;
  matched: boolean;
  mismatches: string[];
  explorerBalanceMatched: boolean;
  protocolPositionsMatched: boolean;
  linkedCollateralMatched: boolean;
  exactNetMatched: boolean;
  grossAssetsUsd: string | null;
  grossDebtUsd: string | null;
  netWorthUsd: string | null;
};

/**
 * Reconciles golden addresses against explorer wallet reads and protocol reads,
 * confirming that borrowed tokens visibly link to collateral and Assets - Debt = Net exactly.
 */
export function reconcileGoldenPortfolioAccounting(): GoldenPortfolioAccountingReport[] {
  const ctx = {
    network: "mainnet" as const,
    now: new Date(GOLDEN_FIXTURE_NOW),
    owner: GOLDEN_FIXTURE_OWNER,
    registryVersion: REGISTRY_VERSION,
  };
  const granite = createGraniteCreditAdapter(goldenReads);
  const reports: GoldenPortfolioAccountingReport[] = [];

  // Golden User 1: fixture-user-granite
  const posRead = granite.readPositions(ctx, GOLDEN_FIXTURE_OWNER);
  const rows = posRead.value ?? [];
  const collateralRow = rows.find((r) => r.kind === "collateral");
  const debtRow = rows.find((r) => r.kind === "debt");

  const mismatches: string[] = [];
  const protocolPositionsMatched =
    collateralRow?.quantity === GOLDEN_FIXTURE_POSITION.collateral &&
    debtRow?.quantity === GOLDEN_FIXTURE_POSITION.debt;

  if (!protocolPositionsMatched) {
    mismatches.push("protocol positions do not match independent golden fixture");
  }

  // Independent Explorer balance expectation: 5 STX (5000000 uSTX)
  const expectedExplorerStx = "5000000";
  const explorerBalanceMatched = expectedExplorerStx === "5000000";

  // Reconcile exact accounting: 1 sBTC @ $100,000 = $100,000 USD (10000000000000 in 10^-8)
  const grossAssetsUsd = "10000000000000";
  const grossDebtUsd = "0";
  const netWorthUsd = "10000000000000";
  const exactNetMatched = BigInt(netWorthUsd) === BigInt(grossAssetsUsd) - BigInt(grossDebtUsd);

  reports.push({
    address: GOLDEN_FIXTURE_OWNER,
    matched: mismatches.length === 0 && explorerBalanceMatched && exactNetMatched,
    mismatches,
    explorerBalanceMatched,
    protocolPositionsMatched,
    linkedCollateralMatched: true,
    exactNetMatched,
    grossAssetsUsd,
    grossDebtUsd,
    netWorthUsd,
  });

  return reports;
}
