import { capabilityFor, contract } from "@stacks-capital/config";
import {
  amount,
  assertOracleFresh,
  assertPositive,
  capitalError,
  parseQuantity,
  projectedHealth,
  sip10,
  validatePlan,
  type Action,
  type AssetRiskSide,
  type ClarityValue,
  type Health,
  type OracleQuote,
  type Plan,
  type Quote,
  type RiskParams,
  type StacksNetwork,
} from "@stacks-capital/core";
import type { AdapterReads, OracleSnapshot } from "../reads.ts";
import type { AdapterContext, Intent, Market, ProtocolAdapter } from "../types.ts";

export const GRANITE_CREDIT_VERSION = "granite-credit@0.1.0";
export const GRANITE_MARKET_ISOLATED = "granite.sbtc.isolated";

const ACTIONS: Action[] = ["supply", "withdraw_supply", "borrow", "repay"];

function sbtc(network: StacksNetwork) {
  return sip10(network, contract("sbtc", "sbtc-token", network).contractId, "sbtc-token");
}

function usdcx(network: StacksNetwork) {
  return sip10(network, contract("usdcx", "usdcx", network).contractId, "usdcx");
}

function marketFor(ctx: AdapterContext, action: Action): Market {
  const capability = capabilityFor(action, ctx.network, "granite");
  return {
    id: GRANITE_MARKET_ISOLATED,
    protocol: "granite",
    action,
    network: ctx.network,
    suppliedAsset: "sbtc-token",
    state: capability?.state ?? "disabled",
    warnings:
      capability?.state === "enabled"
        ? ["Isolated sBTC collateral is not a Zest zsBTC receipt and is not lent out."]
        : [capability?.reason ?? "Granite credit is not available"],
  };
}

function optionalPrincipal(value: string | undefined): ClarityValue {
  if (value === undefined) return { type: "none" };
  return { type: "some", value: { type: "principal", value } };
}

function asOracle(snapshot: OracleSnapshot): OracleQuote {
  return {
    price: parseQuantity(snapshot.price),
    scale: parseQuantity(snapshot.scale),
    observedAt: snapshot.observedAt,
    source: snapshot.source,
    stale: snapshot.stale,
    maxAgeMs: snapshot.maxAgeMs,
  };
}

function requireReads(
  ctx: AdapterContext,
  reads: AdapterReads,
): {
  collateral: Omit<AssetRiskSide, "amount">;
  debt: Omit<AssetRiskSide, "amount">;
  params: RiskParams;
  collateralBefore: bigint;
  debtBefore: bigint;
} {
  if (reads.oracle === undefined || reads.riskParams === undefined) {
    throw capitalError("ORACLE_STALE", "Granite quotes require fixture or live oracle and risk parameters");
  }
  const sbtcOracle = asOracle(reads.oracle.sbtc);
  const usdcxOracle = asOracle(reads.oracle.usdcx);
  assertOracleFresh(sbtcOracle, ctx.now, "sBTC");
  assertOracleFresh(usdcxOracle, ctx.now, "USDCx");
  return {
    collateral: { decimals: parseQuantity(reads.riskParams.sbtcDecimals), oracle: sbtcOracle },
    debt: { decimals: parseQuantity(reads.riskParams.usdcxDecimals), oracle: usdcxOracle },
    params: {
      ltvBorrowBps: parseQuantity(reads.riskParams.ltvBorrowBps),
      ltvLiqBps: parseQuantity(reads.riskParams.ltvLiqBps),
      bufferBps: parseQuantity(reads.riskParams.bufferBps),
    },
    collateralBefore: parseQuantity(reads.position?.collateral ?? "0"),
    debtBefore: parseQuantity(reads.position?.debt ?? "0"),
  };
}

function healthFor(ctx: AdapterContext, intent: Intent, reads: AdapterReads): Health {
  const loaded = requireReads(ctx, reads);
  const bufferBps = intent.bufferBps !== undefined ? parseQuantity(intent.bufferBps) : loaded.params.bufferBps;
  const collateralDelta =
    intent.action === "supply"
      ? parseQuantity(intent.amount)
      : intent.action === "withdraw_supply"
        ? -parseQuantity(intent.amount)
        : intent.collateralAmount !== undefined
          ? parseQuantity(intent.collateralAmount)
          : 0n;
  const debtDelta =
    intent.action === "borrow"
      ? parseQuantity(intent.amount)
      : intent.action === "repay"
        ? -parseQuantity(intent.amount)
        : 0n;
  return projectedHealth({
    collateralBefore: loaded.collateralBefore,
    debtBefore: loaded.debtBefore,
    collateralDelta,
    debtDelta,
    collateral: loaded.collateral,
    debt: loaded.debt,
    params: { ...loaded.params, bufferBps },
    now: ctx.now,
  });
}

export function createGraniteCreditAdapter(reads: AdapterReads): ProtocolAdapter {
  return {
    protocol: "granite",
    version: GRANITE_CREDIT_VERSION,
    describeCapabilities(ctx) {
      return ACTIONS.map((action) => capabilityFor(action, ctx.network, "granite")).filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      );
    },
    listMarkets(ctx) {
      return ACTIONS.map((action) => marketFor(ctx, action));
    },
    getMarket(ctx, marketId) {
      if (marketId !== GRANITE_MARKET_ISOLATED) throw capitalError("UNSUPPORTED_ACTION", marketId);
      return marketFor(ctx, "supply");
    },
    readPositions(ctx, owner) {
      return {
        value: [
          { owner, marketId: GRANITE_MARKET_ISOLATED, kind: "collateral", quantity: reads.position?.collateral ?? "0" },
          { owner, marketId: GRANITE_MARKET_ISOLATED, kind: "debt", quantity: reads.position?.debt ?? "0" },
        ],
        observedAt: ctx.now.toISOString(),
        source: reads.source ?? reads.oracle?.sbtc.source ?? "fixture",
        stale: reads.oracle?.sbtc.stale ?? true,
        warnings: [],
      };
    },
    quote(ctx, intent) {
      return quoteCredit(ctx, intent, reads);
    },
    buildPlan(ctx, quote, intent) {
      return buildCreditPlan(ctx, quote, intent, reads);
    },
    validatePlan(_ctx, plan, quote, signing) {
      return validatePlan(plan, quote, signing);
    },
    decodeEvents(_ctx, raw) {
      return raw
        .filter((event) => /collateral-add|collateral-remove|borrow|repay/.test(event.payload))
        .map((event) => ({
          id: event.id,
          kind: event.payload.includes("repay")
            ? "granite_repay"
            : event.payload.includes("borrow")
              ? "granite_borrow"
              : event.payload.includes("collateral-remove")
                ? "granite_collateral_remove"
                : "granite_collateral_add",
          blockHash: event.blockHash,
          canonical: true,
        }));
    },
    reconcile(_ctx, expected, observed) {
      return {
        matched: expected === observed,
        warnings: expected === observed ? [] : ["Granite position does not match the planned collateral or debt delta"],
      };
    },
    explainRisk(ctx) {
      const capability = capabilityFor("borrow", ctx.network, "granite");
      const alerts: string[] = [];
      let health: Health | undefined;
      try {
        health = healthFor(ctx, { action: "borrow", marketId: GRANITE_MARKET_ISOLATED, amount: "0" }, reads);
        const debt = parseQuantity(reads.position?.debt ?? "0");
        if (health.stale) alerts.push("Oracle is stale; quotes fail closed.");
        if (debt > 0n && !health.withinBuffer) alerts.push("LTV is inside the buffer to liquidation.");
        if (debt > 0n && !health.healthy && !health.stale) alerts.push("Position is above borrow LTV.");
      } catch {
        alerts.push("Oracle is stale; quotes fail closed.");
      }
      return {
        disclosures: [
          "Granite isolated collateral is locked sBTC. It is not zsBTC and is not lent to other users.",
          "Borrow and repay are USDCx on v0-8-market. Price-feeds are omitted only when the oracle is already fresh.",
          "Health, LTV and max borrow use bigint math. Stale oracles fail closed. Buffer alerts are advisory.",
          "Fixture LTV/buffer values are not live governance parameters.",
        ],
        stale: capability?.state !== "enabled" || health?.stale === true,
        variables: {
          ltvBorrowBps: reads.riskParams?.ltvBorrowBps ?? "unverified",
          ltvLiqBps: reads.riskParams?.ltvLiqBps ?? "unverified",
          bufferBps: reads.riskParams?.bufferBps ?? "unverified",
          maxBorrow: health?.maxBorrow.toString(10) ?? "0",
          currentLtvBps: health?.currentLtvBps.toString(10) ?? "0",
          healthFactorBps: health?.healthFactorBps.toString(10) ?? "0",
        },
        alerts,
      };
    },
  };
}

function quoteCredit(ctx: AdapterContext, intent: Intent, reads: AdapterReads): Quote {
  if (!ACTIONS.includes(intent.action)) throw capitalError("UNSUPPORTED_ACTION", intent.action);
  if (intent.marketId !== GRANITE_MARKET_ISOLATED) throw capitalError("UNSUPPORTED_ACTION", intent.marketId);
  const capability = capabilityFor(intent.action, ctx.network, "granite");
  if (ctx.network !== "mainnet") {
    throw capitalError(
      "CAPABILITY_DISABLED",
      capability?.reason ?? "Granite v0-8-market is not deployed on public Stacks testnet",
    );
  }
  const qty = parseQuantity(intent.amount);
  const inputAsset =
    intent.action === "supply" || intent.action === "withdraw_supply" ? sbtc(ctx.network) : usdcx(ctx.network);
  assertPositive(amount(inputAsset, qty), "granite amount");

  const health = healthFor(ctx, intent, reads);
  if (health.stale) throw capitalError("ORACLE_STALE", health.warnings.join("; ") || "oracle is stale");
  if ((intent.action === "borrow" || intent.action === "withdraw_supply") && !health.healthy) {
    throw capitalError("CAP_REACHED", "projected health is above borrow LTV");
  }
  if (intent.action === "borrow") {
    const loaded = requireReads(ctx, reads);
    const extraCollateral = intent.collateralAmount !== undefined ? parseQuantity(intent.collateralAmount) : 0n;
    if (loaded.collateralBefore + extraCollateral <= 0n)
      throw capitalError("INSUFFICIENT_BALANCE", "isolated collateral is required before borrow");
    if (loaded.debtBefore + qty > health.maxBorrow)
      throw capitalError("CAP_REACHED", `borrow exceeds max ${health.maxBorrow.toString(10)}`);
    const available = reads.debtVault !== undefined ? parseQuantity(reads.debtVault.totalAssets) : undefined;
    if (available !== undefined && qty > available)
      throw capitalError("CAP_REACHED", "USDCx vault liquidity is insufficient");
  }

  const collateralIn = intent.collateralAmount !== undefined ? parseQuantity(intent.collateralAmount) : 0n;
  const sending =
    intent.action === "supply"
      ? [amount(sbtc(ctx.network), qty)]
      : intent.action === "repay"
        ? [amount(usdcx(ctx.network), qty)]
        : intent.action === "borrow" && collateralIn > 0n
          ? [amount(sbtc(ctx.network), collateralIn)]
          : [];
  const receiving =
    intent.action === "borrow"
      ? [amount(usdcx(ctx.network), qty)]
      : intent.action === "withdraw_supply"
        ? [amount(sbtc(ctx.network), qty)]
        : intent.action === "supply"
          ? [amount(sbtc(ctx.network), qty)]
          : [];

  const executable = capability?.state === "enabled";
  const warnings = [...(executable ? [] : [capability?.reason ?? "disabled"]), ...health.warnings];
  const quote: Quote = {
    id: `q_granite_${intent.action}_${ctx.now.getTime()}`,
    action: intent.action,
    marketId: GRANITE_MARKET_ISOLATED,
    network: ctx.network,
    input: sending,
    expectedOutput: receiving,
    fees: [],
    snapshots: [
      `market:${contract("zest", "v0-8-market", ctx.network).contractId}`,
      `ltv:${health.currentLtvBps.toString(10)}`,
      `maxBorrow:${health.maxBorrow.toString(10)}`,
    ],
    expiresAt: new Date(ctx.now.getTime() + 2 * 60_000).toISOString(),
    executable,
    warnings,
    registryVersion: ctx.registryVersion,
    adapterVersion: GRANITE_CREDIT_VERSION,
  };
  if (receiving[0] !== undefined) quote.minimumOutput = receiving[0];
  return quote;
}

function buildCreditPlan(ctx: AdapterContext, quote: Quote, intent: Intent, _reads: AdapterReads): Plan {
  if (!quote.executable)
    throw capitalError("CAPABILITY_DISABLED", quote.warnings.join("; ") || "granite is not executable");
  const sender = ctx.owner;
  if (sender === undefined) throw capitalError("PLAN_INVALID", "owner is required to set post conditions");
  const market = contract("zest", "v0-8-market", ctx.network);
  const sbtcToken = contract("sbtc", "sbtc-token", ctx.network).contractId;
  const usdcxToken = contract("usdcx", "usdcx", ctx.network).contractId;
  const recipient = intent.recipient;
  const steps = [];

  if (intent.action === "borrow" && intent.collateralAmount !== undefined) {
    const collateral = amount(sbtc(ctx.network), intent.collateralAmount);
    steps.push({
      id: "collateral-add",
      dependsOn: [] as string[],
      expectedAssetEffects: [collateral],
      payload: {
        kind: "stacks_contract_call" as const,
        contractId: market.contractId,
        functionName: "collateral-add",
        functionArgs: [
          { type: "principal" as const, value: sbtcToken },
          { type: "uint" as const, value: intent.collateralAmount },
          { type: "none" as const },
        ],
        postConditions: [{ principal: sender, mode: "send_lte" as const, amount: collateral }],
        postConditionMode: "deny" as const,
        network: ctx.network,
      },
    });
  }

  if (intent.action === "supply") {
    const sending = amount(sbtc(ctx.network), intent.amount);
    steps.push({
      id: "collateral-add",
      dependsOn: [],
      expectedAssetEffects: quote.expectedOutput,
      payload: {
        kind: "stacks_contract_call" as const,
        contractId: market.contractId,
        functionName: "collateral-add",
        functionArgs: [
          { type: "principal" as const, value: sbtcToken },
          { type: "uint" as const, value: intent.amount },
          { type: "none" as const },
        ],
        postConditions: [{ principal: sender, mode: "send_lte" as const, amount: sending }],
        postConditionMode: "deny" as const,
        network: ctx.network,
      },
    });
  } else if (intent.action === "withdraw_supply") {
    const receiving = amount(sbtc(ctx.network), intent.amount);
    steps.push({
      id: "collateral-remove",
      dependsOn: [],
      expectedAssetEffects: quote.expectedOutput,
      payload: {
        kind: "stacks_contract_call" as const,
        contractId: market.contractId,
        functionName: "collateral-remove",
        functionArgs: [
          { type: "principal" as const, value: sbtcToken },
          { type: "uint" as const, value: intent.amount },
          optionalPrincipal(recipient),
          { type: "none" as const },
        ],
        postConditions: [{ principal: recipient ?? sender, mode: "receive_gte" as const, amount: receiving }],
        postConditionMode: "deny" as const,
        network: ctx.network,
      },
    });
  } else if (intent.action === "borrow") {
    const receiving = amount(usdcx(ctx.network), intent.amount);
    steps.push({
      id: "borrow",
      dependsOn: intent.collateralAmount !== undefined ? ["collateral-add"] : [],
      expectedAssetEffects: [receiving],
      payload: {
        kind: "stacks_contract_call" as const,
        contractId: market.contractId,
        functionName: "borrow",
        functionArgs: [
          { type: "principal" as const, value: usdcxToken },
          { type: "uint" as const, value: intent.amount },
          optionalPrincipal(recipient),
          { type: "none" as const },
        ],
        postConditions: [{ principal: recipient ?? sender, mode: "receive_gte" as const, amount: receiving }],
        postConditionMode: "deny" as const,
        network: ctx.network,
      },
    });
  } else if (intent.action === "repay") {
    const sending = amount(usdcx(ctx.network), intent.amount);
    steps.push({
      id: "repay",
      dependsOn: [],
      expectedAssetEffects: quote.expectedOutput,
      payload: {
        kind: "stacks_contract_call" as const,
        contractId: market.contractId,
        functionName: "repay",
        functionArgs: [
          { type: "principal" as const, value: usdcxToken },
          { type: "uint" as const, value: intent.amount },
          optionalPrincipal(intent.onBehalfOf),
        ],
        postConditions: [{ principal: sender, mode: "send_lte" as const, amount: sending }],
        postConditionMode: "deny" as const,
        network: ctx.network,
      },
    });
  }

  if (steps.length === 0) throw capitalError("PLAN_INVALID", "no granite steps");
  const twoStep = intent.action === "borrow" && intent.collateralAmount !== undefined;
  return {
    id: `p_granite_${quote.id}`,
    quoteId: quote.id,
    network: ctx.network,
    registryVersion: ctx.registryVersion,
    adapterVersion: GRANITE_CREDIT_VERSION,
    expiresAt: quote.expiresAt,
    reviewSummary: twoStep
      ? `Add ${intent.collateralAmount} sBTC isolated collateral, then borrow ${intent.amount} USDCx on v0-8-market. price-feeds none because the oracle is fresh.`
      : `${intent.action} ${intent.amount} on Granite v0-8-market. Isolated collateral is not a Zest receipt. Oracle max age 3 minutes.`,
    steps,
  };
}
