import { capabilityFor, contract } from "@stacks-capital/config";
import {
  amount,
  assertPositive,
  capitalError,
  mulDiv,
  parseQuantity,
  sip10,
  validatePlan,
  type Action,
  type Plan,
  type Quote,
  type StacksNetwork,
} from "@stacks-capital/core";
import type { AdapterReads } from "../reads.ts";
import type { AdapterContext, Intent, Market, ProtocolAdapter } from "../types.ts";

export const ZEST_EARN_VERSION = "zest-earn@0.1.0";
export const ZEST_MARKET_SBTC = "zest.sbtc.vault";

function sbtc(network: StacksNetwork) {
  return sip10(network, contract("sbtc", "sbtc-token", network).contractId, "sbtc-token");
}

function zsbtc(network: StacksNetwork) {
  const vault = contract("zest", "v0-vault-sbtc", network);
  return sip10(network, vault.contractId, "zsBTC");
}

function vaultMarket(ctx: AdapterContext, action: Action): Market {
  const capability = capabilityFor(action, ctx.network, "zest");
  return {
    id: ZEST_MARKET_SBTC,
    protocol: "zest",
    action,
    network: ctx.network,
    suppliedAsset: "sbtc-token",
    receiptAsset: "zsBTC",
    state: capability?.state ?? "disabled",
    warnings: capability?.state === "enabled" ? [] : [capability?.reason ?? "Zest earn is not available"],
  };
}

export function createZestEarnAdapter(reads: AdapterReads): ProtocolAdapter {
  return {
    protocol: "zest",
    version: ZEST_EARN_VERSION,
    describeCapabilities(ctx) {
      return ["supply", "withdraw_supply"]
        .map((action) => capabilityFor(action as Action, ctx.network, "zest"))
        .filter((item): item is NonNullable<typeof item> => item !== undefined);
    },
    listMarkets(ctx) {
      return [vaultMarket(ctx, "supply"), vaultMarket(ctx, "withdraw_supply")];
    },
    getMarket(ctx, marketId) {
      if (marketId !== ZEST_MARKET_SBTC) throw capitalError("UNSUPPORTED_ACTION", marketId);
      return vaultMarket(ctx, "supply");
    },
    readPositions(ctx, owner) {
      return {
        value: [{ owner, marketId: ZEST_MARKET_SBTC, kind: "supplied", quantity: reads.balances?.zsbtc ?? "0" }],
        observedAt: ctx.now.toISOString(),
        source: reads.source ?? (reads.vault ? "vault-snapshot" : "fixture"),
        stale: false,
        warnings: [],
      };
    },
    quote(ctx, intent) {
      return quoteEarn(ctx, intent, reads);
    },
    buildPlan(ctx, quote, intent) {
      return buildEarnPlan(ctx, quote, intent, reads);
    },
    validatePlan(_ctx, plan, quote, signing) {
      return validatePlan(plan, quote, signing);
    },
    decodeEvents(_ctx, raw) {
      return raw
        .filter((event) => event.payload.includes("deposit") || event.payload.includes("redeem"))
        .map((event) => ({
          id: event.id,
          kind: event.payload.includes("redeem") ? "zest_redeem" : "zest_deposit",
          blockHash: event.blockHash,
          canonical: true,
        }));
    },
    reconcile(_ctx, expected, observed) {
      return {
        matched: expected === observed,
        warnings: expected === observed ? [] : ["Vault position does not match the planned share delta"],
      };
    },
    explainRisk(ctx) {
      const vault = reads.vault;
      return {
        disclosures: [
          "zsBTC is a receipt claim on supplied sBTC, not a second asset in portfolio value.",
          "Share conversion rounds down; min-out is enforced onchain.",
          "Pyth/Lazer prices are required for borrow health, not for this vault supply path.",
        ],
        stale: capabilityFor("supply", ctx.network, "zest")?.state !== "enabled",
        variables: {
          pausedDeposit: String(vault?.pausedDeposit ?? false),
          pausedRedeem: String(vault?.pausedRedeem ?? false),
          rounding: "down",
        },
        alerts: [],
      };
    },
  };
}

function sharesForAssets(assets: bigint, reads: AdapterReads): bigint {
  const vault = reads.vault;
  if (vault === undefined) return assets;
  return mulDiv(assets, parseQuantity(vault.shareRateNumerator), parseQuantity(vault.shareRateDenominator), "down");
}

function assetsForShares(shares: bigint, reads: AdapterReads): bigint {
  const vault = reads.vault;
  if (vault === undefined) return shares;
  return mulDiv(shares, parseQuantity(vault.shareRateDenominator), parseQuantity(vault.shareRateNumerator), "down");
}

function quoteEarn(ctx: AdapterContext, intent: Intent, reads: AdapterReads): Quote {
  if (intent.action !== "supply" && intent.action !== "withdraw_supply") {
    throw capitalError("UNSUPPORTED_ACTION", intent.action);
  }
  const capability = capabilityFor(intent.action, ctx.network, "zest");
  if (ctx.network !== "mainnet") {
    throw capitalError("CAPABILITY_DISABLED", capability?.reason ?? "Zest v2 is not deployed on public Stacks testnet");
  }
  const inputQty = parseQuantity(intent.amount);
  assertPositive(amount(sbtc(ctx.network), inputQty), "earn amount");
  const paused = intent.action === "supply" ? reads.vault?.pausedDeposit : reads.vault?.pausedRedeem;
  if (paused) throw capitalError("CAPABILITY_DISABLED", "vault pause is on");
  if (intent.action === "supply" && reads.vault !== undefined) {
    const total = parseQuantity(reads.vault.totalAssets);
    const cap = parseQuantity(reads.vault.capSupply);
    if (total + inputQty > cap) throw capitalError("CAP_REACHED", "supply cap would be exceeded");
  }

  const outputQty = intent.action === "supply" ? sharesForAssets(inputQty, reads) : assetsForShares(inputQty, reads);
  const minOut = intent.minOut !== undefined ? parseQuantity(intent.minOut) : outputQty;
  if (outputQty < minOut) throw capitalError("QUOTE_EXPIRED", "preview is below min-out");

  const inputAsset = intent.action === "supply" ? sbtc(ctx.network) : zsbtc(ctx.network);
  const outputAsset = intent.action === "supply" ? zsbtc(ctx.network) : sbtc(ctx.network);
  const executable = capability?.state === "enabled";
  return {
    id: `q_zest_${intent.action}_${ctx.now.getTime()}`,
    action: intent.action,
    marketId: ZEST_MARKET_SBTC,
    network: ctx.network,
    input: [amount(inputAsset, inputQty)],
    expectedOutput: [amount(outputAsset, outputQty)],
    fees: [],
    snapshots: [`vault:${reads.vault?.totalAssets ?? "1:1"}`],
    expiresAt: new Date(ctx.now.getTime() + 2 * 60_000).toISOString(),
    executable,
    warnings: executable ? [] : [capability?.reason ?? "disabled"],
    registryVersion: ctx.registryVersion,
    adapterVersion: ZEST_EARN_VERSION,
    minimumOutput: amount(outputAsset, minOut),
  };
}

function buildEarnPlan(ctx: AdapterContext, quote: Quote, intent: Intent, _reads: AdapterReads): Plan {
  if (!quote.executable)
    throw capitalError("CAPABILITY_DISABLED", quote.warnings.join("; ") || "earn is not executable");
  const sender = ctx.owner;
  if (sender === undefined) throw capitalError("PLAN_INVALID", "owner is required to set post conditions");
  const recipient = intent.recipient ?? sender;
  const minOut = quote.minimumOutput?.quantity.toString(10) ?? intent.amount;
  const vault = contract("zest", "v0-vault-sbtc", ctx.network);
  const fn = quote.action === "supply" ? "deposit" : "redeem";
  const sending = quote.input[0];
  if (sending === undefined) throw capitalError("PLAN_INVALID", "quote input missing");
  return {
    id: `p_zest_${quote.id}`,
    quoteId: quote.id,
    network: ctx.network,
    registryVersion: ctx.registryVersion,
    adapterVersion: ZEST_EARN_VERSION,
    expiresAt: quote.expiresAt,
    reviewSummary:
      quote.action === "supply"
        ? `Supply ${intent.amount} sBTC to v0-vault-sbtc for zsBTC. Receipt tokens are the claim, not extra portfolio value.`
        : `Redeem ${intent.amount} zsBTC from v0-vault-sbtc. min-out ${minOut} is enforced onchain.`,
    steps: [
      {
        id: fn,
        dependsOn: [],
        expectedAssetEffects: quote.expectedOutput,
        payload: {
          kind: "stacks_contract_call",
          contractId: vault.contractId,
          functionName: fn,
          functionArgs: [
            { type: "uint", value: intent.amount },
            { type: "uint", value: minOut },
            { type: "principal", value: recipient },
          ],
          postConditions: [{ principal: sender, mode: "send_lte", amount: sending }],
          postConditionMode: "deny",
          network: ctx.network,
        },
      },
    ],
  };
}
