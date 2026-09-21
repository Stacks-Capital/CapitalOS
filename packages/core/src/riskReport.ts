import {
  computeHealth,
  type AssetRiskSide,
  type Health,
  type OracleQuote,
  type RiskParams,
  oracleFresh,
} from "./risk.ts";

/** Bumps when health, scenario or action semantics change. */
export const RISK_CALCULATION_VERSION = "risk@1.0.0";

export type RiskProtocol = "granite" | "zest" | "bitflow" | "sbtc" | "unknown";

export type GraniteHealthInterpretation = {
  calculationVersion: string;
  protocol: "granite";
  kind: "credit_health";
  healthFactorBps: bigint;
  currentLtvBps: bigint;
  liquidationThresholdBps: bigint;
  borrowLtvBps: bigint;
  /** HF_bps / 10000 relative to liquidation LTV. At 1.0 the position is at the liquidation threshold. */
  meaning: string;
  liquidatable: boolean;
  withinBorrowCap: boolean;
  withinBuffer: boolean;
  healthy: boolean;
  stale: boolean;
  inputs: {
    collateralUsd: bigint;
    debtUsd: bigint;
    maxBorrow: bigint;
    bufferBps: bigint;
  };
  limitations: string[];
  warnings: string[];
};

export const GRANITE_HEALTH_LIMITATIONS: readonly string[] = [
  "Granite health factor uses liquidation LTV: HF_bps = (collateralUsd × ltvLiqBps) / debtUsd. 10000 means HF 1.0 at the liquidation threshold.",
  "healthy requires HF ≥ 10000 and current LTV ≤ borrow LTV.",
  "withinBuffer is advisory (borrow LTV minus buffer); it does not change on-chain liquidation.",
  "Zero debt uses a sentinel HF of 100000 bps (10.0), not an invented infinite value.",
  "Stale oracles fail closed: numeric health is unavailable and must not be treated as zero risk.",
];

/**
 * Protocol-specific reading of Granite isolated-market health.
 * Does not invent prices or parameters — only interprets a previously computed Health.
 */
export function interpretGraniteHealth(health: Health, params: RiskParams): GraniteHealthInterpretation {
  const liquidatable = !health.stale && health.debtUsd > 0n && health.currentLtvBps >= params.ltvLiqBps;
  const withinBorrowCap = !health.stale && health.currentLtvBps <= params.ltvBorrowBps;
  const meaning = health.stale
    ? "Oracle evidence is stale; Granite health factor is unavailable."
    : health.debtUsd === 0n
      ? "No USDCx debt. Sentinel health factor 10.0; liquidation does not apply until debt is opened."
      : liquidatable
        ? "Current LTV is at or above the Granite liquidation threshold (HF < 1.0)."
        : health.healthy
          ? "HF ≥ 1.0 and LTV is within the Granite borrow cap."
          : "HF or borrow-cap check failed; new borrow or collateral withdrawal is unsafe.";

  return {
    calculationVersion: RISK_CALCULATION_VERSION,
    protocol: "granite",
    kind: "credit_health",
    healthFactorBps: health.healthFactorBps,
    currentLtvBps: health.currentLtvBps,
    liquidationThresholdBps: params.ltvLiqBps,
    borrowLtvBps: params.ltvBorrowBps,
    meaning,
    liquidatable,
    withinBorrowCap,
    withinBuffer: health.withinBuffer,
    healthy: health.healthy,
    stale: health.stale,
    inputs: {
      collateralUsd: health.collateralUsd,
      debtUsd: health.debtUsd,
      maxBorrow: health.maxBorrow,
      bufferBps: params.bufferBps,
    },
    limitations: [...GRANITE_HEALTH_LIMITATIONS],
    warnings: [...health.warnings],
  };
}

export type CreditProtectiveActionId = "borrow" | "repay" | "supply" | "withdraw_supply";

export type ProtectiveAction = {
  action: CreditProtectiveActionId;
  allowed: boolean;
  reason: string;
};

export type ProtectiveActionReport = {
  calculationVersion: string;
  protocol: "granite";
  actions: ProtectiveAction[];
  limitations: string[];
};

/**
 * Safe supported actions for Granite isolated credit from evidenced health and liquidity.
 * Never invents an action for an unsupported protocol path.
 */
export function graniteProtectiveActions(input: {
  health: Health;
  vaultPaused?: boolean;
  /** USDCx vault liquidity in debt base units; null means unknown (borrow blocked). */
  liquidityAvailable?: bigint | null;
  requestedBorrow?: bigint;
}): ProtectiveActionReport {
  const limitations = [
    ...GRANITE_HEALTH_LIMITATIONS,
    "Protective actions are advisory for the host app; the unsigned plan still fails closed on stale oracles and caps.",
  ];
  const paused = input.vaultPaused === true;
  const requested = input.requestedBorrow ?? 0n;
  const liquidity = input.liquidityAvailable;
  const liquidityOk =
    liquidity === undefined ? true : liquidity === null ? false : requested <= 0n || requested <= liquidity;

  const canRiskWrite = !input.health.stale && input.health.healthy;
  const actions: ProtectiveAction[] = [
    {
      action: "supply",
      allowed: !input.health.stale,
      reason: input.health.stale
        ? "Oracle is stale; collateral add is blocked until a fresh price is evidenced."
        : "Adding isolated sBTC collateral is supported when the oracle is fresh.",
    },
    {
      action: "borrow",
      allowed: canRiskWrite && !paused && liquidityOk,
      reason: input.health.stale
        ? "Oracle is stale; borrow is blocked."
        : !input.health.healthy
          ? "Projected health is outside the Granite borrow cap or liquidation buffer."
          : paused
            ? "USDCx vault redeem is paused."
            : !liquidityOk
              ? "USDCx vault liquidity is unknown or insufficient for the requested borrow."
              : "Borrow is within evidenced health and liquidity.",
    },
    {
      action: "repay",
      allowed: !input.health.stale,
      reason: input.health.stale
        ? "Oracle is stale; repay quotes fail closed until a fresh price is evidenced."
        : "Repay reduces debt and is the primary protective action when LTV is elevated.",
    },
    {
      action: "withdraw_supply",
      allowed: canRiskWrite,
      reason: input.health.stale
        ? "Oracle is stale; collateral withdrawal is blocked."
        : !input.health.healthy
          ? "Withdrawing collateral would leave the position outside the Granite borrow cap."
          : "Collateral withdrawal stays within evidenced health.",
    },
  ];

  return { calculationVersion: RISK_CALCULATION_VERSION, protocol: "granite", actions, limitations };
}

export type StressAssumptions = {
  collateralFeed: string;
  debtFeed: string;
  collateralPrice: string;
  publishedAt: string;
  liquidationThresholdBps: string;
  note: string;
};

export type StressScenarioRow = {
  shiftBps: number;
  label: string;
  /** Null when the scenario could not be computed from evidenced inputs. */
  health: Health | null;
  unavailableReason: string | null;
};

export type StressScenarioReport = {
  calculationVersion: string;
  protocol: "granite";
  assumptions: StressAssumptions;
  limitations: string[];
  rows: StressScenarioRow[];
};

/**
 * Shift an evidenced collateral oracle price. Returns null when the shift would invent a
 * non-positive price or the base price is missing.
 */
export function shiftOraclePrice(basePrice: bigint, shiftBps: number): bigint | null {
  if (basePrice <= 0n) return null;
  if (!Number.isInteger(shiftBps)) return null;
  const factor = 10_000n + BigInt(shiftBps);
  if (factor <= 0n) return null;
  return (basePrice * factor) / 10_000n;
}

/**
 * Evidence-backed collateral price stress for Granite. Never invents a base price or debt price.
 */
export function stressGraniteCollateral(input: {
  collateral: AssetRiskSide;
  debt: AssetRiskSide;
  params: RiskParams;
  now: Date;
  collateralFeed: string;
  debtFeed: string;
  shiftsBps: readonly number[];
}): StressScenarioReport {
  const limitations = [
    ...GRANITE_HEALTH_LIMITATIONS,
    "Only the collateral oracle price is shifted by the declared bps. Debt price, interest accrual and protocol parameters are held still.",
    "Scenarios are withheld when any oracle is stale or a shift would invent a non-positive price.",
  ];
  const assumptions: StressAssumptions = {
    collateralFeed: input.collateralFeed,
    debtFeed: input.debtFeed,
    collateralPrice: input.collateral.oracle.price.toString(10),
    publishedAt: input.collateral.oracle.observedAt,
    liquidationThresholdBps: input.params.ltvLiqBps.toString(10),
    note: "Only the collateral price moves. Debt, interest and the protocol's parameters are held still.",
  };

  const blocker = (): string | null => {
    if (!oracleFresh(input.collateral.oracle, input.now)) {
      return `The ${input.collateralFeed} price is stale.`;
    }
    if (!oracleFresh(input.debt.oracle, input.now)) {
      return `The ${input.debtFeed} price is stale.`;
    }
    if (input.collateral.oracle.price <= 0n) return `No evidenced price for ${input.collateralFeed}.`;
    if (input.debt.oracle.price <= 0n) return `No evidenced price for ${input.debtFeed}.`;
    return null;
  };

  const reason = blocker();
  const rows = input.shiftsBps.map((shiftBps) => {
    const label = `${shiftBps < 0 ? "" : "+"}${(shiftBps / 100).toFixed(0)}%`;
    if (reason !== null) return { shiftBps, label, health: null, unavailableReason: reason };
    const moved = shiftOraclePrice(input.collateral.oracle.price, shiftBps);
    if (moved === null) {
      return {
        shiftBps,
        label,
        health: null,
        unavailableReason: "That price shift is unsupported because it would invent a non-positive price.",
      };
    }
    const health = computeHealth({
      collateral: {
        ...input.collateral,
        oracle: { ...input.collateral.oracle, price: moved },
      },
      debt: input.debt,
      params: input.params,
      now: input.now,
    });
    return { shiftBps, label, health, unavailableReason: null };
  });

  return {
    calculationVersion: RISK_CALCULATION_VERSION,
    protocol: "granite",
    assumptions,
    limitations,
    rows,
  };
}

export type ConcentrationSlice = {
  key: string;
  quantity: bigint;
  shareBps: bigint;
};

export type ConcentrationReport = {
  calculationVersion: string;
  available: boolean;
  reason: string | null;
  total: bigint | null;
  slices: ConcentrationSlice[];
  limitations: string[];
};

/**
 * Same-asset quantity concentration. Mixed assets or unknown quantities fail closed —
 * never invent a share of an unknown total.
 */
export function concentrationByQuantity(
  slices: readonly { key: string; quantity: bigint | null; assetId: string }[],
): ConcentrationReport {
  const limitations = [
    "Concentration is measured in base-unit quantities within one asset. Cross-asset shares require fresh oracles for every slice and are not invented here.",
    "Unknown quantities make the whole calculation unavailable.",
  ];
  if (slices.length === 0) {
    return {
      calculationVersion: RISK_CALCULATION_VERSION,
      available: false,
      reason: "No positions have been projected for this address yet.",
      total: null,
      slices: [],
      limitations,
    };
  }
  const unknown = slices.filter((slice) => slice.quantity === null);
  if (unknown.length > 0) {
    return {
      calculationVersion: RISK_CALCULATION_VERSION,
      available: false,
      reason: `Some positions are unknown (${[...new Set(unknown.map((s) => s.key))].join(", ")}), so shares cannot be worked out.`,
      total: null,
      slices: [],
      limitations,
    };
  }
  const assets = new Set(slices.map((slice) => slice.assetId));
  if (assets.size > 1) {
    return {
      calculationVersion: RISK_CALCULATION_VERSION,
      available: false,
      reason: "Positions are held in different assets, which cannot be added together.",
      total: null,
      slices: [],
      limitations,
    };
  }

  const totals = new Map<string, bigint>();
  let total = 0n;
  for (const slice of slices) {
    const quantity = slice.quantity ?? 0n;
    total += quantity;
    totals.set(slice.key, (totals.get(slice.key) ?? 0n) + quantity);
  }
  if (total === 0n) {
    return {
      calculationVersion: RISK_CALCULATION_VERSION,
      available: false,
      reason: "Nothing is held in these markets, so there is nothing to compare.",
      total: null,
      slices: [],
      limitations,
    };
  }

  return {
    calculationVersion: RISK_CALCULATION_VERSION,
    available: true,
    reason: null,
    total,
    slices: [...totals.entries()]
      .map(([key, quantity]) => ({ key, quantity, shareBps: (quantity * 10_000n) / total }))
      .sort((left, right) => (right.shareBps > left.shareBps ? 1 : right.shareBps < left.shareBps ? -1 : 0)),
    limitations,
  };
}

export type LiquidityGate = {
  calculationVersion: string;
  sufficient: boolean | null;
  available: bigint | null;
  requested: bigint;
  limitations: string[];
  reason: string;
};

/** Vault/pool liquidity gate — unknown liquidity never silently allows a borrow. */
export function borrowLiquidityGate(available: bigint | null, requested: bigint): LiquidityGate {
  const limitations = [
    "Liquidity is protocol vault totalAssets evidence. Null means unknown and fails closed.",
    "This gate does not invent available liquidity from quotes or prior observations.",
  ];
  if (available === null) {
    return {
      calculationVersion: RISK_CALCULATION_VERSION,
      sufficient: null,
      available: null,
      requested,
      limitations,
      reason: "Vault liquidity is unknown; borrow is blocked.",
    };
  }
  const sufficient = requested <= available;
  return {
    calculationVersion: RISK_CALCULATION_VERSION,
    sufficient,
    available,
    requested,
    limitations,
    reason: sufficient
      ? "Requested borrow is within evidenced vault liquidity."
      : "Requested borrow exceeds evidenced vault liquidity.",
  };
}

export type UnsupportedCreditRisk = {
  calculationVersion: string;
  protocol: RiskProtocol;
  kind: "unavailable";
  reason: string;
  limitations: string[];
};

/** Non-credit protocols do not expose a liquidation health factor. */
export function unsupportedCreditRisk(protocol: RiskProtocol, reason: string): UnsupportedCreditRisk {
  return {
    calculationVersion: RISK_CALCULATION_VERSION,
    protocol,
    kind: "unavailable",
    reason,
    limitations: [
      "Health factor and borrow LTV apply only to Granite isolated credit.",
      "Earn and swap surfaces use protocol disclosures and route/vault evidence instead of inventing a health factor.",
    ],
  };
}

export function wouldLiquidateAtLtv(currentLtvBps: bigint, liquidationThresholdBps: bigint): boolean {
  return currentLtvBps >= liquidationThresholdBps;
}
