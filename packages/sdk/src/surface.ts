import type { Action, StacksNetwork } from "@stacks-capital/core";

/**
 * Page 11/14 partner packages. Removing a name is a breaking change; adding one is not.
 * Type-only exports are not listed: they disappear at runtime.
 */
export const PUBLIC_VALUE_EXPORTS = {
  "@stacks-capital/sdk": [
    "BITCOIN_FOR_STACKS",
    "LAUNCH_DECISION",
    "REGISTRY_VERSION",
    "RISK_CALCULATION_VERSION",
    "allowsWriteRetry",
    "assertReadyToSign",
    "canSubmitWrite",
    "capitalError",
    "classifyWalletError",
    "completeFromReconciliation",
    "concentrationByQuantity",
    "createCapitalOS",
    "executable",
    "graniteProtectiveActions",
    "interpretGraniteHealth",
    "isRetryableRead",
    "launchRow",
    "marketsComparable",
    "networkGuard",
    "parsePlan",
    "parseQuote",
    "requireNetwork",
    "resumeHint",
    "serializePlan",
    "serializeQuote",
    "stressGraniteCollateral",
  ],
  "@stacks-capital/client": [
    "CLIENT_ID_HEADER",
    "CapitalApiError",
    "CapitalConfigError",
    "CapitalTransportError",
    "DEFAULT_RETRY",
    "DEFAULT_STALE_MS",
    "DEFAULT_TIMEOUT_MS",
    "RESOURCES",
    "SCHEMA_VERSION",
    "cacheKey",
    "createCache",
    "createClient",
    "errorClassOf",
    "isRetryable",
    "sameScope",
    "scopeKey",
  ],
  "@stacks-capital/react": [
    "CapitalProvider",
    "useCapabilities",
    "useCapital",
    "useCapitalQuery",
    "useEarnOptions",
    "useMarketRisk",
    "useMarkets",
    "usePositions",
    "usePrices",
    "useWorkflow",
    "useWorkflows",
  ],
  "@stacks-capital/ui": [
    "EarnComparison",
    "PositionsSummary",
    "QuoteSummary",
    "WorkflowHistory",
    "askWallet",
    "assertWalletAllowed",
    "canSign",
    "compareEarn",
    "connectWallet",
    "nextBorrowStep",
    "projectBorrow",
    "quoteSafety",
    "reviewQuote",
    "signIn",
    "swapView",
    "toWalletRequest",
  ],
} as const;

/** These never ship to a partner app. The embed-example boundary rule already enforces the same split. */
export const PARTNER_FORBIDDEN_PACKAGES = [
  "@stacks-capital/adapters",
  "@stacks-capital/database",
  "@stacks-capital/engine",
  "@stacks-capital/fixtures",
] as const;

export const PUBLIC_PACKAGES = [
  "@stacks-capital/core",
  "@stacks-capital/wallets",
  "@stacks-capital/sdk",
  "@stacks-capital/client",
  "@stacks-capital/react",
  "@stacks-capital/ui",
] as const;

export const SCHEMA_VERSION_LOCK = "1.0";

export function missingExports(exported: object, required: readonly string[]): string[] {
  return required.filter((name) => !Object.hasOwn(exported, name));
}

export type Certification = "sandbox" | "not-certified" | "disabled";

export type LaunchRow = {
  action: Action;
  protocol: string;
  network: StacksNetwork;
  certification: Certification;
  reason: string;
};

/**
 * K20. Architecture launch rule: ship the verified surface, not the promised surface.
 * Production is no-go. Sandbox certification is the partner quote → validate → AWAITING_SIGNATURE path.
 */
export const LAUNCH_DECISION = {
  production: "no-go" as const,
  sandboxCertification: "go" as const,
  closedEarnPilot: "no-go" as const,
  schemaVersion: SCHEMA_VERSION_LOCK,
  webhooks: "not-certified" as const,
  rows: [
    {
      action: "deposit_sbtc",
      protocol: "sbtc",
      network: "mainnet",
      certification: "not-certified",
      reason: "Adapter is enabled; there is no product screen and no Bitcoin/Emily ingestion (I20 B2).",
    },
    {
      action: "deposit_sbtc",
      protocol: "sbtc",
      network: "testnet",
      certification: "disabled",
      reason: "Emily beta does not track public Stacks testnet; Leather has no Bitcoin regtest.",
    },
    {
      action: "withdraw_sbtc",
      protocol: "sbtc",
      network: "mainnet",
      certification: "not-certified",
      reason: "Adapter is enabled; the BTC holder exit is not in the app (I20 B2).",
    },
    {
      action: "withdraw_sbtc",
      protocol: "sbtc",
      network: "testnet",
      certification: "disabled",
      reason: "Same testnet signer/Emily mismatch as deposit.",
    },
    {
      action: "supply",
      protocol: "zest",
      network: "mainnet",
      certification: "sandbox",
      reason: "Partner program quotes, SDK-validates, and stops at AWAITING_SIGNATURE. SDK never broadcasts.",
    },
    {
      action: "withdraw_supply",
      protocol: "zest",
      network: "mainnet",
      certification: "not-certified",
      reason: "Adapter is enabled; workflows do not move past SUBMITTED (I20 B1), so a live exit is not certified.",
    },
    {
      action: "supply",
      protocol: "zest",
      network: "testnet",
      certification: "disabled",
      reason: "Zest v2 is not deployed on public Stacks testnet.",
    },
    {
      action: "supply",
      protocol: "granite",
      network: "mainnet",
      certification: "not-certified",
      reason: "Positions cannot be read from the registered contract; DIA USDC is unset (I20 B3).",
    },
    {
      action: "withdraw_supply",
      protocol: "granite",
      network: "mainnet",
      certification: "not-certified",
      reason: "Same unread Granite position and USDC feed gap (I20 B3).",
    },
    {
      action: "borrow",
      protocol: "granite",
      network: "mainnet",
      certification: "not-certified",
      reason: "Fail-closed in practice until I11 positions and I06 USDC/USD exist (I20 B3).",
    },
    {
      action: "repay",
      protocol: "granite",
      network: "mainnet",
      certification: "not-certified",
      reason: "Same Granite live-read gap as borrow (I20 B3).",
    },
    {
      action: "supply",
      protocol: "granite",
      network: "testnet",
      certification: "disabled",
      reason: "Granite v0-8-market is not deployed on public Stacks testnet.",
    },
    {
      action: "borrow",
      protocol: "granite",
      network: "testnet",
      certification: "disabled",
      reason: "Granite v0-8-market is not deployed on public Stacks testnet.",
    },
    {
      action: "swap",
      protocol: "bitflow",
      network: "mainnet",
      certification: "not-certified",
      reason: "Live pool principal is not pinned; swap stays on fixture routes (I20 B6).",
    },
    {
      action: "swap",
      protocol: "bitflow",
      network: "testnet",
      certification: "disabled",
      reason: "Bitflow has no public testnet ticker or router.",
    },
    {
      action: "stake",
      protocol: "pox",
      network: "mainnet",
      certification: "disabled",
      reason: "K16: BTC lockup signing path is unverified. Staking stays off.",
    },
    {
      action: "stake",
      protocol: "pox",
      network: "testnet",
      certification: "disabled",
      reason: "K16: staking remains disabled on both networks.",
    },
  ] as const satisfies readonly LaunchRow[],
};

export function launchRow(action: Action, network: StacksNetwork, protocol: string): LaunchRow | undefined {
  return LAUNCH_DECISION.rows.find(
    (row) => row.action === action && row.network === network && row.protocol === protocol,
  );
}
