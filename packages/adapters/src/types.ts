import type {
  Action,
  CanonicalActivity,
  DataPoint,
  Plan,
  PlanValidation,
  Quote,
  SigningContext,
  StacksNetwork,
} from "@stacks-capital/core";
import type { CapabilityRecord } from "@stacks-capital/config";

export type AdapterContext = {
  network: StacksNetwork;
  now: Date;
  owner?: string;
  registryVersion: string;
};

export type Market = {
  id: string;
  protocol: string;
  action: Action;
  network: StacksNetwork;
  suppliedAsset: string;
  receiptAsset?: string;
  state: CapabilityRecord["state"];
  warnings: string[];
};

export type Position = {
  owner: string;
  marketId: string;
  kind: string;
  quantity: string;
  blockHeight?: number;
};

export type Intent = {
  action: Action;
  marketId: string;
  amount: string;
  recipient?: string;
  maxFee?: string;
  minOut?: string;
  collateralAmount?: string;
  slippageBps?: string;
  bufferBps?: string;
  onBehalfOf?: string;
  routePool?: string;
  inputAsset?: string;
};

export type Reconciliation = {
  matched: boolean;
  warnings: string[];
};

export type RiskExplanation = {
  disclosures: string[];
  stale: boolean;
  variables: Record<string, string>;
  alerts: string[];
};

export type ProtocolAdapter = {
  protocol: string;
  version: string;
  describeCapabilities(ctx: AdapterContext): CapabilityRecord[];
  listMarkets(ctx: AdapterContext): Market[];
  getMarket(ctx: AdapterContext, marketId: string): Market;
  readPositions(ctx: AdapterContext, owner: string): DataPoint<Position[]>;
  quote(ctx: AdapterContext, intent: Intent): Quote;
  buildPlan(ctx: AdapterContext, quote: Quote, intent: Intent): Plan;
  validatePlan(ctx: AdapterContext, plan: Plan, quote: Quote, signing: SigningContext): PlanValidation;
  decodeEvents(
    ctx: AdapterContext,
    raw: readonly { id: string; payload: string; blockHash: string }[],
  ): CanonicalActivity[];
  reconcile(ctx: AdapterContext, expected: string, observed: string): Reconciliation;
  explainRisk(ctx: AdapterContext, marketId: string): RiskExplanation;
};
