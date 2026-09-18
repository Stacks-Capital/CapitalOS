import { randomBytes } from "node:crypto";
import type { AdapterReads } from "@stacks-capital/adapters";
import {
  createWorkflow,
  quoteExpired,
  recordUnknownBroadcast,
  transition,
  walletOutcome,
  type Intent,
  type Plan,
  type Quote,
  type StacksNetwork,
  type Workflow,
} from "@stacks-capital/core";
import {
  createWorkflowRow,
  effectiveCapability,
  recordOpsEvent,
  latestPositions,
  latestPrices,
  findAttempt,
  findStoredQuote,
  findWorkflowForTenant,
  insertPlan,
  insertQuote,
  recordAttempt,
  type Sql,
} from "@stacks-capital/database";
import { createExecutionEngine, loadServerReads } from "@stacks-capital/engine";
import { ApiError } from "./errors.ts";

/** Reads are injected so tests use fixtures and production uses live provider reads with the server's key. */
export type ReadsLoader =
  | AdapterReads
  | ((network: StacksNetwork, owner: string | undefined) => AdapterReads | Promise<AdapterReads>);

export async function loadReads(
  reads: ReadsLoader,
  network: StacksNetwork,
  owner: string | undefined,
): Promise<AdapterReads> {
  return typeof reads === "function" ? reads(network, owner) : reads;
}

export function liveReads(apiKey: string | undefined): ReadsLoader {
  return (network, owner) =>
    loadServerReads({
      network,
      ...(owner === undefined ? {} : { owner }),
      ...(apiKey === undefined ? {} : { hiroApiKey: apiKey }),
    });
}

export type QuoteInput = {
  network: StacksNetwork;
  marketId: string;
  action: string;
  amount: string;
  owner: string;
  slippageBps?: string | undefined;
  maxFee?: string | undefined;
};

/** Quoting runs the engine here, on the server, where the provider keys live. */
/**
 * The registry state after operator switches (I17). Every path that could lead to a signed transaction
 * checks this, so switching a capability off stops new quotes, new plans and new workflows at once.
 */
export async function requireEnabled(
  sql: Sql,
  input: { network: StacksNetwork; marketId: string; action: string },
): Promise<void> {
  const capability = await effectiveCapability(sql, input);
  if (capability === null) throw new ApiError("UNSUPPORTED_ACTION", `${input.marketId} does not list ${input.action}`);
  if (capability.state !== "enabled") {
    throw new ApiError(
      "CAPABILITY_DISABLED",
      `${input.marketId} ${input.action} is ${capability.state}: ${capability.reason}`,
    );
  }
}

/** Every quote attempt is counted, success or failure, so operators see failure rates per market. */
export async function createQuote(
  deps: { sql: Sql; reads: ReadsLoader; now: () => Date },
  input: QuoteInput,
): Promise<{ quote: Quote; plan: Plan }> {
  const event = { network: input.network, subject: input.marketId, at: deps.now() };
  try {
    await requireEnabled(deps.sql, input);
    const quoted = await quoteUnchecked(deps, input);
    await recordOpsEvent(deps.sql, { ...event, kind: "quote_succeeded" }).catch(() => {});
    return quoted;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "INTERNAL";
    // Losing a metric must never lose the answer to the caller.
    await recordOpsEvent(deps.sql, { ...event, kind: "quote_failed", code }).catch(() => {});
    throw error;
  }
}

async function quoteUnchecked(
  deps: { sql: Sql; reads: ReadsLoader; now: () => Date },
  input: QuoteInput,
): Promise<{ quote: Quote; plan: Plan }> {
  let reads: AdapterReads;
  try {
    reads = await loadReads(deps.reads, input.network, input.owner);
  } catch (error) {
    throw asApiError(error, "Market data is unavailable right now");
  }

  const intent: Intent = {
    action: input.action as Intent["action"],
    marketId: input.marketId,
    amount: input.amount,
    recipient: input.owner,
  };
  if (input.slippageBps !== undefined) intent.slippageBps = input.slippageBps;
  if (input.maxFee !== undefined) intent.maxFee = input.maxFee;

  let quoted: { quote: Quote; plan: Plan };
  try {
    quoted = createExecutionEngine({
      network: input.network,
      reads,
      owner: input.owner,
      now: deps.now(),
    }).quoteAndPlan(intent);
  } catch (error) {
    throw asApiError(error, "This market cannot be quoted");
  }

  const at = deps.now();
  await insertQuote(deps.sql, quoted.quote, at);
  await insertPlan(deps.sql, quoted.plan, at);
  return quoted;
}

export type StartInput = {
  network: StacksNetwork;
  quoteId: string;
  idempotencyKey: string;
  appId: string;
  ownerAddress: string;
};

export async function startWorkflow(
  deps: { sql: Sql; now: () => Date },
  input: StartInput,
): Promise<{ workflow: Workflow; plan: Plan; created: boolean }> {
  const stored = await findStoredQuote(deps.sql, { quoteId: input.quoteId, network: input.network });
  if (stored === null) throw new ApiError("NOT_FOUND", "No such quote");
  // A quote made before an operator switched the capability off must not start a workflow after it.
  await requireEnabled(deps.sql, {
    network: input.network,
    marketId: stored.quote.marketId,
    action: stored.quote.action,
  });
  if (quoteExpired(stored.quote, deps.now()))
    throw new ApiError("QUOTE_EXPIRED", "That quote has expired. Ask for a new one");
  if (!stored.quote.executable) {
    throw new ApiError(
      "CAPABILITY_DISABLED",
      `${stored.quote.marketId} cannot be executed: ${stored.quote.warnings.join("; ")}`,
    );
  }

  const at = deps.now().toISOString();
  let workflow = createWorkflow({
    id: `wf_${randomBytes(8).toString("hex")}`,
    network: input.network,
    idempotencyKey: input.idempotencyKey,
    at,
  });
  workflow = transition(workflow, "QUOTED", { reason: "Quote accepted", actor: "api", evidence: stored.quote.id, at });
  workflow = transition(workflow, "AWAITING_SIGNATURE", {
    reason: "Plan sent to the wallet",
    actor: "api",
    evidence: stored.plan.id,
    at,
  });
  workflow = { ...workflow, quoteId: stored.quote.id, planId: stored.plan.id };

  const result = await createWorkflowRow(deps.sql, {
    workflow,
    appId: input.appId,
    ownerAddress: input.ownerAddress,
    plan: stored.plan,
    at: deps.now(),
  });

  // The same idempotency key always names the same workflow, so a retry never starts a second one.
  if (!result.created) {
    const existing = await findWorkflowForTenant(deps.sql, {
      id: result.id,
      appId: input.appId,
      ownerAddress: input.ownerAddress,
    });
    if (existing === null) throw new ApiError("FORBIDDEN", "That idempotency key belongs to another caller");
    return {
      workflow: { ...workflow, id: existing.id, state: existing.state as never },
      plan: stored.plan,
      created: false,
    };
  }
  return { workflow, plan: stored.plan, created: true };
}

export type SignatureInput = {
  network: StacksNetwork;
  workflowId: string;
  stepId: string;
  appId: string;
  ownerAddress: string | null;
  /** Exactly what the wallet returned. Core decides what it means. */
  walletResult: unknown;
};

/**
 * Records what the wallet answered. A result without a txid is BROADCAST_UNKNOWN, never a silent retry,
 * because resubmitting could move the money twice (page 01, I02).
 */
export async function recordSignature(
  deps: { sql: Sql; now: () => Date },
  input: SignatureInput,
): Promise<{ state: string; nextAction: string; outcome: "BROADCAST" | "SIGNED" | "UNKNOWN"; txid: string | null }> {
  const record = await findWorkflowForTenant(deps.sql, {
    id: input.workflowId,
    appId: input.appId,
    ownerAddress: input.ownerAddress,
  });
  if (record === null) throw new ApiError("NOT_FOUND", "No such workflow");
  if (record.network !== input.network) throw new ApiError("NETWORK_MISMATCH", `Workflow is on ${record.network}`);

  const existing = await findAttempt(deps.sql, { workflowId: input.workflowId, stepId: input.stepId });
  if (existing !== null) {
    // The step already has an answer. Reporting it again changes nothing.
    return {
      state: record.state,
      nextAction: record.nextAction,
      outcome: existing.outcome as "BROADCAST" | "SIGNED" | "UNKNOWN",
      txid: existing.txid,
    };
  }

  const outcome = walletOutcome(input.walletResult);
  const txid =
    outcome === "BROADCAST" && typeof (input.walletResult as { txid?: unknown }).txid === "string"
      ? (input.walletResult as { txid: string }).txid
      : null;

  const before: Workflow = {
    id: record.id,
    network: record.network,
    state: record.state as never,
    nextAction: record.nextAction as never,
    idempotencyKey: "",
    transitions: record.transitions.map((move) => ({
      from: move.from as never,
      to: move.to as never,
      reason: move.reason,
      actor: move.actor,
      evidence: move.evidence,
      at: new Date(move.at).toISOString(),
    })),
  };

  const at = deps.now().toISOString();
  let after: Workflow;
  try {
    after =
      outcome === "BROADCAST"
        ? transition(before, "SUBMITTED", {
            reason: "Wallet returned a txid",
            actor: "wallet",
            evidence: txid ?? "",
            at,
          })
        : recordUnknownBroadcast(before, `wallet outcome ${outcome}`);
  } catch (error) {
    throw asApiError(error, "The workflow cannot move from its current state");
  }

  await recordAttempt(deps.sql, {
    attempt: {
      workflowId: record.id,
      stepId: input.stepId,
      network: record.network,
      chain: "stacks",
      outcome,
      txid,
      evidence: `wallet result recorded at ${at}`,
      at: deps.now(),
    },
    workflow: after,
    moves: after.transitions.slice(before.transitions.length),
  });

  return { state: after.state, nextAction: after.nextAction, outcome, txid };
}

function asApiError(error: unknown, fallback: string): ApiError {
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? fallback;
  const known = [
    "CAPABILITY_DISABLED",
    "UNSUPPORTED_ACTION",
    "ORACLE_STALE",
    "QUOTE_EXPIRED",
    "CAP_REACHED",
    "PLAN_INVALID",
    "INSUFFICIENT_BALANCE",
    "NETWORK_MISMATCH",
    "PROVIDER_TIMEOUT",
    "RATE_LIMITED",
  ];
  return known.includes(code ?? "") ? new ApiError(code as never, message) : new ApiError("INTERNAL", fallback);
}

export type RiskView = {
  marketId: string;
  params: {
    ltvBorrowBps: string;
    ltvLiqBps: string;
    bufferBps: string;
    collateralDecimals: number;
    debtDecimals: number;
  } | null;
  collateralOracle: OracleView;
  debtOracle: OracleView;
  position: { collateral: string | null; debt: string | null; stale: boolean; warnings: string[] };
  warnings: string[];
};

export type OracleView = {
  feedKey: string;
  price: string | null;
  scale: number;
  publishedAt: string | null;
  observedAt: string;
  source: string;
  stale: boolean;
  warnings: string[];
};

const FEEDS = { collateral: "BTC/USD", debt: "USDC/USD" } as const;

function oracleView(
  feedKey: string,
  row: Awaited<ReturnType<typeof latestPrices>>[number] | undefined,
  at: Date,
): OracleView {
  if (row === undefined) {
    return {
      feedKey,
      price: null,
      scale: 8,
      publishedAt: null,
      observedAt: at.toISOString(),
      source: "none",
      stale: true,
      warnings: [`No price has been read for ${feedKey} yet`],
    };
  }
  return {
    feedKey,
    price: row.price,
    scale: row.priceScale,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    observedAt: row.observedAt.toISOString(),
    source: row.source,
    stale: row.stale,
    warnings: row.warnings,
  };
}

/**
 * What a screen needs to project health before it asks for a quote: the protocol's risk parameters,
 * the prices the platform has read, and what the address already holds. Anything missing stays null.
 */
export async function marketRisk(
  deps: { sql: Sql; reads: ReadsLoader; now: () => Date },
  input: { network: StacksNetwork; marketId: string; owner: string | null },
): Promise<RiskView> {
  const at = deps.now();
  const prices = await latestPrices(deps.sql, input.network, [FEEDS.collateral, FEEDS.debt]);
  const byFeed = new Map(prices.map((price) => [price.feedKey, price]));
  const warnings: string[] = [];

  let params: RiskView["params"] = null;
  try {
    const reads = await loadReads(deps.reads, input.network, input.owner ?? undefined);
    const risk = reads.riskParams;
    if (risk === undefined) warnings.push("The protocol did not return its risk parameters");
    else {
      params = {
        ltvBorrowBps: risk.ltvBorrowBps,
        ltvLiqBps: risk.ltvLiqBps,
        bufferBps: risk.bufferBps,
        collateralDecimals: Number(risk.sbtcDecimals),
        debtDecimals: Number(risk.usdcxDecimals),
      };
    }
  } catch (error) {
    warnings.push(`Risk parameters are unavailable: ${(error as Error).message}`);
  }

  // Positions come from the worker's projections, and stay unknown when no read exists (I11).
  let position: RiskView["position"] = { collateral: null, debt: null, stale: true, warnings: [] };
  if (input.owner !== null) {
    const held = await latestPositions(deps.sql, { network: input.network, owner: input.owner });
    const forMarket = held.filter((row) => row.marketId === input.marketId);
    const collateral = forMarket.find((row) => row.kind === "collateral");
    const debt = forMarket.find((row) => row.kind === "debt");
    position = {
      collateral: collateral?.quantity ?? null,
      debt: debt?.quantity ?? null,
      stale: (collateral?.stale ?? true) || (debt?.stale ?? true),
      warnings: [...(collateral?.warnings ?? []), ...(debt?.warnings ?? [])],
    };
    if (forMarket.length === 0) position.warnings.push(`No position has been projected for ${input.marketId} yet`);
  } else {
    position.warnings.push("Sign in to see your own position");
  }

  return {
    marketId: input.marketId,
    params,
    collateralOracle: oracleView(FEEDS.collateral, byFeed.get(FEEDS.collateral), at),
    debtOracle: oracleView(FEEDS.debt, byFeed.get(FEEDS.debt), at),
    position,
    warnings,
  };
}
