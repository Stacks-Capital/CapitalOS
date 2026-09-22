import {
  RISK_CALCULATION_VERSION,
  type AssetRiskSide,
  type Health,
  type OracleQuote,
  type ProtectiveActionReport,
  type RiskParams,
  type StressScenarioReport,
  computeHealth,
  graniteProtectiveActions,
  interpretGraniteHealth,
  stressGraniteCollateral,
} from "@stacks-capital/core";
import type { MarketRisk, OracleQuoteView } from "@stacks-capital/client";

/**
 * Standard BTC collateral stress shifts: -5%, -10%, -20%, -30%, -50%
 */
export const STANDARD_BTC_STRESS_SHIFTS_BPS: readonly number[] = [-500, -1000, -2000, -3000, -5000];

export type MetricFreshness = "fresh" | "stale" | "disputed" | "unavailable";

export type RiskMetricView = {
  id: string;
  label: string;
  value: string;
  displayValue: string;
  meaning: string;
  source: string;
  timestamp: string;
  calculationVersion: string;
  status: MetricFreshness;
  unit?: string;
  isWarning?: boolean;
};

export type AlertSettings = {
  enabled: boolean;
  minHealthFactor: number; // e.g. 1.25
  staleOracleWarning: boolean;
  consentedAt: string | null;
  limitationsAcknowledged: boolean;
};

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: false,
  minHealthFactor: 1.25,
  staleOracleWarning: true,
  consentedAt: null,
  limitationsAcknowledged: false,
};

export const STORAGE_ALERT_KEY = "capitalos:risk_alert_settings";

export const ALERT_DELIVERY_LIMITATIONS: readonly string[] = [
  "Client-Side Only: Alerts run in the active browser tab via polling. Inactive, throttled, or closed tabs cannot dispatch notifications.",
  "Network & Latency Dependencies: Notification timing depends on RPC query frequency, node latency, and block confirmation speeds.",
  "Advisory Invariant: Alerts do not guarantee automated transaction protection and cannot prevent smart contract liquidations.",
  "Explicit User Consent: Browser notification permissions and alert triggers require user opt-in and can be revoked at any time.",
];

export const BTC_STRESS_COVERAGE_NOTE =
  "Coverage: Granite isolated sBTC / USDCx credit market. Only the collateral price moves. Debt, accrued interest, and protocol liquidation thresholds are held constant.";

/**
 * Helper to safely convert an OracleQuoteView to core's OracleQuote
 */
export function toCoreOracleQuote(quote: OracleQuoteView, fallbackSource: string): OracleQuote {
  const priceBigInt = quote.price ? BigInt(quote.price) : 0n;
  const scaleBigInt = BigInt(quote.scale ?? 8);
  const isDisputed = quote.status === "disputed" || quote.disagreement === true;
  const res: OracleQuote = {
    price: priceBigInt,
    scale: scaleBigInt,
    observedAt: quote.observedAt || new Date().toISOString(),
    source: quote.source || fallbackSource,
    stale: quote.stale || isDisputed,
    maxAgeMs: 180_000,
    disagreement: isDisputed,
  };
  if (quote.status) res.status = quote.status;
  if (quote.warnings) res.warnings = quote.warnings;
  return res;
}

/**
 * Derives a full Granite Risk assessment from MarketRisk data
 */
export function buildGraniteRiskAssessment(
  risk: MarketRisk | null | undefined,
  now: Date = new Date(),
): {
  health: Health | null;
  interpretation: ReturnType<typeof interpretGraniteHealth> | null;
  scenarios: StressScenarioReport | null;
  actions: ProtectiveActionReport | null;
  metrics: RiskMetricView[];
  unavailableReason: string | null;
} {
  if (!risk?.params) {
    return {
      health: null,
      interpretation: null,
      scenarios: null,
      actions: null,
      metrics: [],
      unavailableReason: "Protocol risk parameters are unavailable or cannot be read.",
    };
  }

  const params: RiskParams = {
    ltvBorrowBps: BigInt(risk.params.ltvBorrowBps),
    ltvLiqBps: BigInt(risk.params.ltvLiqBps),
    bufferBps: BigInt(risk.params.bufferBps),
  };

  const collateralDecimals = BigInt(risk.params.collateralDecimals ?? 8);
  const debtDecimals = BigInt(risk.params.debtDecimals ?? 6);

  const collateralAmount = risk.position.collateral ? BigInt(risk.position.collateral) : 0n;
  const debtAmount = risk.position.debt ? BigInt(risk.position.debt) : 0n;

  const collateralOracle = toCoreOracleQuote(risk.collateralOracle, "Granite Pyth sBTC Feed");
  const debtOracle = toCoreOracleQuote(risk.debtOracle, "Granite Redstone USDCx Feed");

  const collateralSide: AssetRiskSide = {
    amount: collateralAmount,
    decimals: collateralDecimals,
    oracle: collateralOracle,
  };

  const debtSide: AssetRiskSide = {
    amount: debtAmount,
    decimals: debtDecimals,
    oracle: debtOracle,
  };

  const health = computeHealth({
    collateral: collateralSide,
    debt: debtSide,
    params,
    now,
  });

  const interpretation = interpretGraniteHealth(health, params);

  const scenarios = stressGraniteCollateral({
    collateral: collateralSide,
    debt: debtSide,
    params,
    now,
    collateralFeed: collateralOracle.source,
    debtFeed: debtOracle.source,
    shiftsBps: STANDARD_BTC_STRESS_SHIFTS_BPS,
  });

  const actions = graniteProtectiveActions({
    health,
    vaultPaused: false,
    liquidityAvailable: null,
  });

  const metrics = formatRiskMetrics(risk, health, params, interpretation);

  return {
    health,
    interpretation,
    scenarios,
    actions,
    metrics,
    unavailableReason: null,
  };
}

/**
 * Formats Granite health metrics with explicit metadata for every number
 */
export function formatRiskMetrics(
  risk: MarketRisk,
  health: Health,
  params: RiskParams,
  interpretation: ReturnType<typeof interpretGraniteHealth>,
): RiskMetricView[] {
  const timestamp = risk.collateralOracle.observedAt || new Date().toISOString();
  const oracleSource = risk.collateralOracle.source || "Pyth Hermes / DIA Oracle";
  const isStale = health.stale;
  const status: MetricFreshness = isStale ? (risk.collateralOracle.disagreement ? "disputed" : "stale") : "fresh";

  const metrics: RiskMetricView[] = [
    {
      id: "health_factor",
      label: "Health Factor",
      value: health.healthFactorBps.toString(),
      displayValue: isStale
        ? "Unavailable (Stale Oracle)"
        : health.debtUsd === 0n
          ? "10.0 (No Debt)"
          : (Number(health.healthFactorBps) / 10000).toFixed(2),
      meaning: interpretation.meaning,
      source: oracleSource,
      timestamp,
      calculationVersion: RISK_CALCULATION_VERSION,
      status,
      isWarning: !isStale && health.debtUsd > 0n && health.healthFactorBps < 12000n,
    },
    {
      id: "current_ltv",
      label: "Current Loan-To-Value (LTV)",
      value: health.currentLtvBps.toString(),
      displayValue: isStale ? "Unavailable" : `${(Number(health.currentLtvBps) / 100).toFixed(2)}%`,
      meaning:
        "Ratio of total borrowed USDCx debt value to deposited sBTC collateral value. Higher LTV represents higher liquidation risk.",
      source: oracleSource,
      timestamp,
      calculationVersion: RISK_CALCULATION_VERSION,
      status,
      unit: "%",
      isWarning: !isStale && health.currentLtvBps > params.ltvBorrowBps,
    },
    {
      id: "liquidation_threshold",
      label: "Liquidation Threshold",
      value: params.ltvLiqBps.toString(),
      displayValue: `${(Number(params.ltvLiqBps) / 100).toFixed(2)}%`,
      meaning:
        "Protocol-enforced maximum LTV. If current LTV reaches or exceeds this threshold, collateral is subject to third-party liquidation.",
      source: "Granite Isolated Pool Smart Contract",
      timestamp,
      calculationVersion: RISK_CALCULATION_VERSION,
      status: "fresh",
      unit: "%",
    },
    {
      id: "borrow_limit",
      label: "Borrow Cap LTV",
      value: params.ltvBorrowBps.toString(),
      displayValue: `${(Number(params.ltvBorrowBps) / 100).toFixed(2)}%`,
      meaning: "Maximum allowable LTV for initiating new borrow transactions or withdrawing collateral.",
      source: "Granite Isolated Pool Smart Contract",
      timestamp,
      calculationVersion: RISK_CALCULATION_VERSION,
      status: "fresh",
      unit: "%",
    },
    {
      id: "safety_buffer",
      label: "Liquidation Safety Buffer",
      value: params.bufferBps.toString(),
      displayValue: `${(Number(params.bufferBps) / 100).toFixed(2)}%`,
      meaning: "Advisory buffer margin between maximum allowable borrow LTV and liquidation threshold.",
      source: "Granite Isolated Pool Smart Contract",
      timestamp,
      calculationVersion: RISK_CALCULATION_VERSION,
      status: "fresh",
      unit: "%",
    },
    {
      id: "collateral_price",
      label: "Collateral Valuation Price",
      value: risk.collateralOracle.price ?? "0",
      displayValue: risk.collateralOracle.price
        ? `$${(Number(risk.collateralOracle.price) / 10 ** (risk.collateralOracle.scale ?? 8)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "Unknown",
      meaning:
        "Canonical valuation price for sBTC provided by verified oracle feed used to calculate collateral capacity.",
      source: oracleSource,
      timestamp,
      calculationVersion: RISK_CALCULATION_VERSION,
      status,
    },
  ];

  return metrics;
}

/**
 * Evaluates whether current position triggers any active alert
 */
export function checkAlertTrigger(
  health: Health | null,
  settings: AlertSettings,
): { triggered: boolean; message: string | null } {
  if (!settings.enabled || !settings.limitationsAcknowledged || !health) {
    return { triggered: false, message: null };
  }

  if (settings.staleOracleWarning && health.stale) {
    return {
      triggered: true,
      message: "Warning: Oracle price telemetry is stale. Health calculations are paused for safety.",
    };
  }

  if (health.debtUsd > 0n && !health.stale) {
    const currentHf = Number(health.healthFactorBps) / 10000;
    if (currentHf < settings.minHealthFactor) {
      return {
        triggered: true,
        message: `Alert: Health Factor has dropped to ${currentHf.toFixed(2)}, which is below your safety threshold of ${settings.minHealthFactor.toFixed(2)}.`,
      };
    }
  }

  return { triggered: false, message: null };
}

/**
 * Storage helpers for Alert Consent & Settings
 */
export function loadAlertSettings(storage?: { getItem: (k: string) => string | null }): AlertSettings {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    const raw = store?.getItem(STORAGE_ALERT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_ALERT_SETTINGS;
}

export function saveAlertSettings(
  settings: AlertSettings,
  storage?: { setItem: (k: string, v: string) => void },
): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    store?.setItem(STORAGE_ALERT_KEY, JSON.stringify(settings));
  } catch {}
}
