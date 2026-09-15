import { capabilityFor, contract, type CapabilityRecord } from "@stacks-capital/config";
import {
  amount,
  assertPositive,
  bitcoinNative,
  capitalError,
  parseQuantity,
  sip10,
  validatePlan,
  type Quote,
  type Plan,
  type StacksNetwork,
} from "@stacks-capital/core";
import type { AdapterContext, Intent, Market, ProtocolAdapter } from "../types.ts";
import type { AdapterReads } from "../reads.ts";

export const SBTC_DEPOSIT_VERSION = "sbtc-deposit@0.1.0";
export const SBTC_MARKET_DEPOSIT = "sbtc.deposit";

function token(network: StacksNetwork) {
  return sip10(network, contract("sbtc", "sbtc-token", network).contractId, "sbtc-token");
}

function market(network: StacksNetwork, capability: CapabilityRecord | undefined): Market {
  return {
    id: SBTC_MARKET_DEPOSIT,
    protocol: "sbtc",
    action: "deposit_sbtc",
    network,
    suppliedAsset: "bitcoin native btc",
    receiptAsset: "sbtc-token",
    state: capability?.state ?? "disabled",
    warnings: capability?.state === "enabled" ? [] : [capability?.reason ?? "deposit is not available"],
  };
}

export function createSbtcDepositAdapter(reads: AdapterReads): ProtocolAdapter {
  return {
    protocol: "sbtc",
    version: SBTC_DEPOSIT_VERSION,
    describeCapabilities(ctx) {
      const found = capabilityFor("deposit_sbtc", ctx.network, "sbtc");
      return found ? [found] : [];
    },
    listMarkets(ctx) {
      return [market(ctx.network, capabilityFor("deposit_sbtc", ctx.network, "sbtc"))];
    },
    getMarket(ctx, marketId) {
      if (marketId !== SBTC_MARKET_DEPOSIT) throw capitalError("UNSUPPORTED_ACTION", marketId);
      return market(ctx.network, capabilityFor("deposit_sbtc", ctx.network, "sbtc"));
    },
    readPositions(ctx, owner) {
      return {
        value: [{ owner, marketId: SBTC_MARKET_DEPOSIT, kind: "pending_deposit", quantity: "0" }],
        observedAt: ctx.now.toISOString(),
        source: "fixture",
        stale: false,
        warnings: [],
      };
    },
    quote(ctx, intent) {
      return quoteDeposit(ctx, intent, reads);
    },
    buildPlan(ctx, quote, intent) {
      return buildDepositPlan(ctx, quote, intent, reads);
    },
    validatePlan(ctx, plan, quote, signing) {
      return validatePlan(plan, quote, signing);
    },
    decodeEvents(_ctx, raw) {
      return raw
        .filter((event) => event.payload.includes("complete-deposit") || event.payload.includes("sbtc mint"))
        .map((event) => ({ id: event.id, kind: "sbtc_mint", blockHash: event.blockHash, canonical: true }));
    },
    reconcile(_ctx, expected, observed) {
      return { matched: expected === observed, warnings: expected === observed ? [] : ["sBTC balance delta does not match the deposit"] };
    },
    explainRisk(ctx) {
      const capability = capabilityFor("deposit_sbtc", ctx.network, "sbtc");
      return {
        disclosures: [
          "Bitcoin confirmation, signer processing and Stacks mint are separate states.",
          "A Bitcoin txid is not completion.",
        ],
        stale: capability?.state !== "enabled",
        variables: { perDepositMinimum: reads.emilyLimits.perDepositMinimum },
        alerts: [],
      };
    },
  };
}

function quoteDeposit(ctx: AdapterContext, intent: Intent, reads: AdapterReads): Quote {
  if (intent.action !== "deposit_sbtc") throw capitalError("UNSUPPORTED_ACTION", intent.action);
  const capability = capabilityFor("deposit_sbtc", ctx.network, "sbtc");
  const btc = amount(bitcoinNative(ctx.network), intent.amount);
  assertPositive(btc, "deposit amount");
  const min = parseQuantity(reads.emilyLimits.perDepositMinimum);
  if (btc.quantity < min) throw capitalError("CAP_REACHED", `below perDepositMinimum ${min}`);
  const maxSigner = intent.maxFee !== undefined ? parseQuantity(intent.maxFee) : 0n;
  if (btc.quantity <= maxSigner) throw capitalError("INSUFFICIENT_BALANCE", "amount must cover the maximum signer fee");
  const sbtcOut = amount(token(ctx.network), btc.quantity - maxSigner);
  const executable = capability?.state === "enabled";
  const quote: Quote = {
    id: `q_dep_${ctx.now.getTime()}`,
    action: "deposit_sbtc",
    marketId: SBTC_MARKET_DEPOSIT,
    network: ctx.network,
    input: [btc],
    expectedOutput: [sbtcOut],
    fees: maxSigner > 0n
      ? [{ kind: "signer", amount: amount(bitcoinNative(ctx.network), maxSigner), max: amount(bitcoinNative(ctx.network), maxSigner) }]
      : [],
    snapshots: [`emily:${reads.emilyLimits.perDepositMinimum}`],
    expiresAt: new Date(ctx.now.getTime() + 10 * 60_000).toISOString(),
    executable,
    warnings: executable ? [] : [capability?.reason ?? "disabled"],
    registryVersion: ctx.registryVersion,
    adapterVersion: SBTC_DEPOSIT_VERSION,
    minimumOutput: sbtcOut,
  };
  return quote;
}

function buildDepositPlan(ctx: AdapterContext, quote: Quote, intent: Intent, reads: AdapterReads): Plan {
  if (!quote.executable) throw capitalError("CAPABILITY_DISABLED", quote.warnings.join("; ") || "deposit is not executable");
  const recipient = intent.recipient;
  if (recipient === undefined) throw capitalError("PLAN_INVALID", "Stacks recipient is required");
  const maxSigner = intent.maxFee ?? "0";
  return {
    id: `p_dep_${quote.id}`,
    quoteId: quote.id,
    network: ctx.network,
    registryVersion: ctx.registryVersion,
    adapterVersion: SBTC_DEPOSIT_VERSION,
    expiresAt: quote.expiresAt,
    reviewSummary: `Send ${intent.amount} sats to the sBTC deposit script for ${recipient}. Completion requires a canonical mint, not the Bitcoin txid.`,
    steps: [
      {
        id: "bitcoin_broadcast",
        dependsOn: [],
        expectedAssetEffects: quote.expectedOutput,
        payload: {
          kind: "bitcoin_deposit",
          amountSats: intent.amount,
          stacksRecipient: recipient,
          bitcoinNetwork: ctx.network === "mainnet" ? "mainnet" : "regtest",
          reclaimLockTime: 144,
          maxSignerFeeSats: maxSigner,
          emilyNotifyPath: "/deposit",
        },
      },
    ],
  };
}
