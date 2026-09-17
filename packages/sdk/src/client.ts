import {
  BITFLOW_MARKET_SBTC_USDCX,
  GRANITE_MARKET_ISOLATED,
  SBTC_MARKET_DEPOSIT,
  SBTC_MARKET_WITHDRAW,
  ZEST_MARKET_SBTC,
  createBitflowSwapAdapter,
  createGraniteCreditAdapter,
  createSbtcDepositAdapter,
  createSbtcWithdrawAdapter,
  createZestEarnAdapter,
  type AdapterContext,
  type AdapterReads,
  type Intent,
  type Market,
  type Position,
  type ProtocolAdapter,
  type Reconciliation,
  type RiskExplanation,
} from "@stacks-capital/adapters";
import { REGISTRY_VERSION, capabilityFor, type CapabilityRecord } from "@stacks-capital/config";
import {
  capitalError,
  createWorkflow,
  marketsComparable,
  requireNetwork,
  transition,
  walletOutcome,
  type Plan,
  type PlanValidation,
  type Quote,
  type SigningContext,
  type StacksNetwork,
  type WalletOutcome,
  type Workflow,
} from "@stacks-capital/core";
import { classifyWalletError, networkGuard, type WalletId } from "@stacks-capital/wallets";
import type { CapitalError, DataPoint, ErrorCode } from "@stacks-capital/core";

export type CapitalOSOptions = {
  network: StacksNetwork;
  reads: AdapterReads;
  owner?: string;
  now?: Date;
};

export type QuotedPlan = {
  quote: Quote;
  plan: Plan;
};

export type CapitalOS = {
  network: StacksNetwork;
  registryVersion: string;
  quote(intent: Intent): Quote;
  plan(quote: Quote, intent: Intent): Plan;
  quoteAndPlan(intent: Intent): QuotedPlan;
  validate(plan: Plan, quote: Quote, signing?: Omit<SigningContext, "network" | "registryVersion" | "now"> & { now?: Date }): PlanValidation;
  markets(): Market[];
  capabilities(): CapabilityRecord[];
  risk(marketId: string): RiskExplanation;
  positions(owner?: string): DataPoint<Position[]>;
  reconcile(marketId: string, expected: string, observed: string): Reconciliation;
  marketsComparable(left: Pick<Market, "protocol" | "action">, right: Pick<Market, "protocol" | "action">): boolean;
  startWorkflow(input: { id: string; idempotencyKey: string }): Workflow;
  recordQuote(workflow: Workflow, quote: Quote): Workflow;
  recordPlan(workflow: Workflow, plan: Plan): Workflow;
  inspectWalletResult(result: unknown): WalletOutcome;
  classifyWalletError(wallet: WalletId, error: unknown): ErrorCode;
  networkGuard(addresses: { stx?: string; btc?: string[] }): CapitalError | null;
  submit(): never;
};

function adapterForMarket(adapters: Record<string, ProtocolAdapter>, marketId: string): ProtocolAdapter {
  const found = adapters[marketId];
  if (found === undefined) throw capitalError("UNSUPPORTED_ACTION", `unknown market ${marketId}`);
  return found;
}

export function createCapitalOS(options: CapitalOSOptions): CapitalOS {
  const network = requireNetwork(options.network);
  const deposit = createSbtcDepositAdapter(options.reads);
  const withdraw = createSbtcWithdrawAdapter(options.reads);
  const zest = createZestEarnAdapter(options.reads);
  const granite = createGraniteCreditAdapter(options.reads);
  const bitflow = createBitflowSwapAdapter(options.reads);
  const adapters: Record<string, ProtocolAdapter> = {
    [SBTC_MARKET_DEPOSIT]: deposit,
    [SBTC_MARKET_WITHDRAW]: withdraw,
    [ZEST_MARKET_SBTC]: zest,
    [GRANITE_MARKET_ISOLATED]: granite,
    [BITFLOW_MARKET_SBTC_USDCX]: bitflow,
  };

  function ctx(): AdapterContext {
    const context: AdapterContext = {
      network,
      now: options.now ?? new Date(),
      registryVersion: REGISTRY_VERSION,
    };
    if (options.owner !== undefined) context.owner = options.owner;
    return context;
  }

  function signingContext(signing: Parameters<CapitalOS["validate"]>[2]): SigningContext {
    const context: SigningContext = {
      now: signing?.now ?? ctx().now,
      network,
      registryVersion: REGISTRY_VERSION,
    };
    const sender = signing?.sender ?? options.owner;
    if (sender !== undefined) context.sender = sender;
    if (signing?.bitcoinAddresses !== undefined) context.bitcoinAddresses = signing.bitcoinAddresses;
    return context;
  }

  return {
    network,
    registryVersion: REGISTRY_VERSION,
    quote(intent) {
      return adapterForMarket(adapters, intent.marketId).quote(ctx(), intent);
    },
    plan(quote, intent) {
      if (quote.marketId !== intent.marketId) throw capitalError("PLAN_INVALID", "quote market does not match intent");
      return adapterForMarket(adapters, intent.marketId).buildPlan(ctx(), quote, intent);
    },
    quoteAndPlan(intent) {
      const quote = adapterForMarket(adapters, intent.marketId).quote(ctx(), intent);
      return { quote, plan: adapterForMarket(adapters, intent.marketId).buildPlan(ctx(), quote, intent) };
    },
    validate(plan, quote, signing) {
      return adapterForMarket(adapters, quote.marketId).validatePlan(ctx(), plan, quote, signingContext(signing));
    },
    markets() {
      return Object.values(adapters).flatMap((adapter) => adapter.listMarkets(ctx()));
    },
    capabilities() {
      const seen = new Set<string>();
      const records: CapabilityRecord[] = [];
      for (const adapter of Object.values(adapters)) {
        for (const record of adapter.describeCapabilities(ctx())) {
          const key = `${record.protocol}:${record.action}:${record.network}`;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push(record);
        }
      }
      return records;
    },
    risk(marketId) {
      return adapterForMarket(adapters, marketId).explainRisk(ctx(), marketId);
    },
    positions(owner) {
      const who = owner ?? options.owner;
      if (who === undefined) throw capitalError("PLAN_INVALID", "owner is required to read positions");
      const value: Position[] = [];
      let stale = false;
      const warnings: string[] = [];
      let source = "sdk";
      const observedAt = ctx().now.toISOString();
      for (const adapter of Object.values(adapters)) {
        const point = adapter.readPositions(ctx(), who);
        stale = stale || point.stale;
        warnings.push(...point.warnings);
        source = point.source;
        if (point.value) value.push(...point.value);
      }
      return { value, observedAt, source, stale, warnings };
    },
    reconcile(marketId, expected, observed) {
      return adapterForMarket(adapters, marketId).reconcile(ctx(), expected, observed);
    },
    marketsComparable(left, right) {
      return marketsComparable(left, right);
    },
    startWorkflow(input) {
      return createWorkflow({ id: input.id, network, idempotencyKey: input.idempotencyKey });
    },
    recordQuote(workflow, quote) {
      if (workflow.network !== network || quote.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
      }
      return transition(workflow, "QUOTED", { reason: "quote", actor: "sdk", evidence: quote.id });
    },
    recordPlan(workflow, plan) {
      if (workflow.network !== network || plan.network !== network) {
        throw capitalError("NETWORK_MISMATCH", "workflow network does not match the SDK network");
      }
      return transition(workflow, "AWAITING_SIGNATURE", { reason: "plan", actor: "sdk", evidence: plan.id });
    },
    inspectWalletResult(result) {
      return walletOutcome(result);
    },
    classifyWalletError(wallet, error) {
      return classifyWalletError(wallet, error);
    },
    networkGuard(addresses) {
      return networkGuard(network, addresses);
    },
    submit(): never {
      throw capitalError("UNSUPPORTED_ACTION", "The SDK does not broadcast. The host wallet submits the unsigned plan.");
    },
  };
}

export function executable(action: CapabilityRecord["action"], network: StacksNetwork, protocol?: string): boolean {
  return capabilityFor(action, requireNetwork(network), protocol)?.state === "enabled";
}
