import type { StacksNetwork } from "@stacks-capital/core";

export const SCHEMA_VERSION = "1.0";

export type CapabilityState = "enabled" | "read_only" | "paused" | "disabled";

export type Capability = {
  action: string;
  state: CapabilityState;
  reason: string;
  contractId: string;
  deploymentId: string | null;
  adapterVersion: string;
  registryVersion: string;
};

export type MarketCapability = Capability & { marketId: string };

export type Market = {
  id: string;
  network: StacksNetwork;
  protocol: string;
  suppliedAssetId: string | null;
  receiptAssetId: string | null;
  capabilities: Capability[];
};

/** Every answer carries where it came from and how fresh it is (page 01 envelope). */
export type ResponseContext = {
  requestId: string;
  network: StacksNetwork;
  observedAt: string;
  stale: boolean;
  warnings: string[];
  blockHeight?: number;
  blockHash?: string;
};

export type Page<T> = { items: T[]; nextCursor: string | null; context: ResponseContext };
export type Result<T> = { data: T; context: ResponseContext };

export type Challenge = { nonceId: string; message: string; expiresAt: string };
export type Session = { token: string; sessionId: string; address: string; expiresAt: string };

export type WorkflowTransition = {
  sequence: number;
  from: string;
  to: string;
  reason: string;
  actor: string;
  evidence: string;
  at: string;
};

export type Workflow = {
  id: string;
  network: StacksNetwork;
  state: string;
  nextAction: string;
  quoteId: string | null;
  planId: string | null;
  action: string | null;
  ownerAddress: string | null;
  createdAt: string;
  updatedAt: string;
  transitions: WorkflowTransition[];
  attempts: {
    stepId: string;
    chain: "bitcoin" | "stacks";
    outcome: "BROADCAST" | "SIGNED" | "UNKNOWN";
    txid: string | null;
    recordedAt: string;
  }[];
};

export type AssetAmount = { asset: string; quantity: string };
export type Fee = { kind: "miner" | "signer" | "protocol" | "network"; amount: AssetAmount; max?: AssetAmount };

export type Quote = {
  id: string;
  action: string;
  marketId: string;
  network: StacksNetwork;
  input: AssetAmount[];
  expectedOutput: AssetAmount[];
  minimumOutput?: AssetAmount;
  fees: Fee[];
  snapshots: string[];
  warnings: string[];
  executable: boolean;
  expiresAt: string;
  registryVersion: string;
  adapterVersion: string;
};

export type PlanStep = {
  id: string;
  payload: { kind: string } & Record<string, unknown>;
  expectedAssetEffects: AssetAmount[];
  dependsOn: string[];
};

export type Plan = {
  id: string;
  quoteId: string;
  network: StacksNetwork;
  steps: PlanStep[];
  reviewSummary: string;
  expiresAt: string;
  registryVersion: string;
  adapterVersion: string;
};

export type QuotedPlan = { quote: Quote; plan: Plan };
export type StartedWorkflow = { workflowId: string; state: string; nextAction: string; plan: Plan };
export type SignatureOutcome = {
  state: string;
  nextAction: string;
  outcome: "BROADCAST" | "SIGNED" | "UNKNOWN";
  txid: string | null;
};

export type PositionKind =
  | "wallet"
  | "supplied"
  | "debt"
  | "collateral"
  | "pending_deposit"
  | "pending_withdrawal"
  | "staked";

export type Position = {
  marketId: string;
  kind: PositionKind;
  protocolKey: string;
  assetId: string;
  /** Null when unknown. Zero is a real balance. */
  quantity: string | null;
  stale: boolean;
  warnings: string[];
  observedAt: string;
  blockHeight: number | null;
  rewardRate: string | null;
  rewardScale: number | null;
  adapterVersion: string;
  calculationVersion: string;
};

export type EarnOptionEvidence = {
  ageSeconds: number | null;
  blockHeight: number | null;
  blockHash: string | null;
  confidence: "high" | "medium" | "low";
  source: string;
  disagreement: "match" | "mismatch" | "unavailable" | null;
  isIndependentRead: boolean;
};

export type EarnOption = {
  marketId: string;
  protocol: string;
  suppliedAssetId: string | null;
  receiptAssetId: string | null;
  supply: { state: string; reason: string };
  /** Null when the market lists no withdrawal action at all. */
  withdrawal: { state: string; reason: string } | null;
  baseRate: string | null;
  baseRateScale: number | null;
  incentiveRate: string | null;
  incentiveRateScale: number | null;
  availableLiquidity: string | null;
  capacity: string | null;
  paused: boolean | null;
  stale: boolean;
  warnings: string[];
  observedAt: string | null;
  adapterVersion: string;
  evidence?: EarnOptionEvidence | undefined;
};

export type MarketObservation = {
  source: string;
  sourceType: "independent" | "provider_reported";
  isIndependentRead: boolean;
  availableLiquidity: string | null;
  capacity: string | null;
  supplyRate: string | null;
  borrowRate: string | null;
  rateScale: number | null;
  paused: boolean | null;
  stale: boolean;
  warnings: string[];
  observedAt: string;
  blockHeight: number | null;
  blockHash: string | null;
};

export type MarketEvidence = {
  marketId: string;
  network: string;
  protocol: string;
  source: string;
  blockHeight: number | null;
  blockHash: string | null;
  observedAt: string | null;
  evidenceAgeSeconds: number | null;
  confidence: "high" | "medium" | "low";
  disagreement: "match" | "mismatch" | "unavailable" | null;
  disagreementDetail: string | null;
  isIndependentRead: boolean;
  rate: {
    supplyRate: string | null;
    borrowRate: string | null;
    rateScale: number | null;
    stale: boolean;
  };
  liquidity: {
    available: string | null;
    capacity: string | null;
    stale: boolean;
  };
  warnings: string[];
  observations: MarketObservation[];
};

export type OracleQuoteView = {
  feedKey: string;
  price: string | null;
  scale: number;
  publishedAt: string | null;
  observedAt: string;
  source: string;
  stale: boolean;
  warnings: string[];
  assetId?: string;
  sourceSet?: string[];
  disagreement?: boolean;
  status?: "verified" | "disputed" | "stale" | "unsupported";
};

export type AssetValuation = {
  assetId: string;
  price: string | null;
  scale: number;
  sourceSet: string[];
  timestamp: string;
  status: "verified" | "disputed" | "stale" | "unsupported";
  disagreement: boolean;
  spreadBps: number | null;
  warnings: string[];
};

export type PortfolioCoverage = {
  isComplete: boolean;
  valuedCount: number;
  unvaluedCount: number;
  totalCount: number;
  coverageBps: number | null;
  valuedAssets: string[];
  unvaluedAssets: Array<{ assetId: string; reason: string; quantity: string | null }>;
};

export type ValuedHoldingItem = {
  assetId: string;
  quantity: string | null;
  decimals: number;
  usdValue: string | null;
  status: "valued" | "unsupported" | "stale" | "disputed" | "missing_quantity";
  unvaluedReason: string | null;
  valuation: AssetValuation | null;
};

export type PortfolioValuation = {
  totalUsd: string | null;
  coverage: PortfolioCoverage;
  items: ValuedHoldingItem[];
  warnings: string[];
};

export type MarketRisk = {
  marketId: string;
  params: {
    ltvBorrowBps: string;
    ltvLiqBps: string;
    bufferBps: string;
    collateralDecimals: number;
    debtDecimals: number;
  } | null;
  collateralOracle: OracleQuoteView;
  debtOracle: OracleQuoteView;
  position: { collateral: string | null; debt: string | null; stale: boolean; warnings: string[] };
  warnings: string[];
};

export type WorkflowSummary = {
  id: string;
  network: StacksNetwork;
  state: string;
  nextAction: string;
  quoteId: string | null;
  planId: string | null;
  action: string | null;
  createdAt: string;
  updatedAt: string;
  transitionCount: number;
};
