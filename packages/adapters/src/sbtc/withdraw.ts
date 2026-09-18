import { capabilityFor, contract, FUNGIBLE_ASSET_NAME } from "@stacks-capital/config";
import {
  amount,
  assertPositive,
  bitcoinNative,
  capitalError,
  formatAssetId,
  parseQuantity,
  sip10,
  validatePlan,
  type Plan,
  type Quote,
  type StacksNetwork,
} from "@stacks-capital/core";
import type { AdapterReads } from "../reads.ts";
import type { AdapterContext, Intent, ProtocolAdapter } from "../types.ts";

export const SBTC_WITHDRAW_VERSION = "sbtc-withdraw@0.1.0";
export const SBTC_MARKET_WITHDRAW = "sbtc.withdraw";
export const WITHDRAWAL_DUST = 546n;

function token(network: StacksNetwork) {
  return sip10(network, contract("sbtc", "sbtc-token", network).contractId, FUNGIBLE_ASSET_NAME.sbtc);
}

export function createSbtcWithdrawAdapter(reads: AdapterReads): ProtocolAdapter {
  return {
    protocol: "sbtc",
    version: SBTC_WITHDRAW_VERSION,
    describeCapabilities(ctx) {
      const found = capabilityFor("withdraw_sbtc", ctx.network, "sbtc");
      return found ? [found] : [];
    },
    listMarkets(ctx) {
      const capability = capabilityFor("withdraw_sbtc", ctx.network, "sbtc");
      return [
        {
          id: SBTC_MARKET_WITHDRAW,
          protocol: "sbtc",
          action: "withdraw_sbtc",
          network: ctx.network,
          suppliedAsset: formatAssetId(token(ctx.network)),
          receiptAsset: formatAssetId(bitcoinNative(ctx.network)),
          state: capability?.state ?? "disabled",
          warnings: capability?.state === "enabled" ? [] : [capability?.reason ?? "withdrawal is not available"],
        },
      ];
    },
    getMarket(ctx, marketId) {
      const [first] = this.listMarkets(ctx);
      if (marketId !== SBTC_MARKET_WITHDRAW || first === undefined) throw capitalError("UNSUPPORTED_ACTION", marketId);
      return first;
    },
    readPositions(ctx, owner) {
      return {
        value: [{ owner, marketId: SBTC_MARKET_WITHDRAW, kind: "pending_withdrawal", quantity: "0" }],
        observedAt: ctx.now.toISOString(),
        source: reads.source ?? "fixture",
        stale: false,
        warnings: [],
      };
    },
    quote(ctx, intent) {
      return quoteWithdraw(ctx, intent, reads);
    },
    buildPlan(ctx, quote, intent) {
      return buildWithdrawPlan(ctx, quote, intent);
    },
    validatePlan(_ctx, plan, quote, signing) {
      return validatePlan(plan, quote, signing);
    },
    decodeEvents(_ctx, raw) {
      return raw
        .filter(
          (event) => event.payload.includes("accept-withdrawal-request") || event.payload.includes("bitcoin payout"),
        )
        .map((event) => ({ id: event.id, kind: "sbtc_payout", blockHash: event.blockHash, canonical: true }));
    },
    reconcile(_ctx, expected, observed) {
      return {
        matched: expected === observed,
        warnings: expected === observed ? [] : ["Bitcoin payout does not match the withdrawal request"],
      };
    },
    explainRisk(ctx) {
      return {
        disclosures: [
          "The Stacks withdrawal request is not completion.",
          "Destination cannot change after submission.",
          "Completion requires signer acceptance and a Bitcoin payout transaction.",
        ],
        stale: capabilityFor("withdraw_sbtc", ctx.network, "sbtc")?.state !== "enabled",
        variables: { perWithdrawalCap: reads.emilyLimits.perWithdrawalCap, dust: WITHDRAWAL_DUST.toString(10) },
        alerts: [],
      };
    },
  };
}

function decodeRecipient(recipient: string): { version: string; hashbytes: string } {
  if (!recipient.includes(":")) throw capitalError("PLAN_INVALID", "recipient must be version:hashbytes");
  const [version, hashbytes] = recipient.split(":");
  if (version === undefined || hashbytes === undefined)
    throw capitalError("PLAN_INVALID", "invalid Bitcoin recipient encoding");
  const versionInt = Number.parseInt(version, 16);
  const bytes = hashbytes.length / 2;
  if (versionInt <= 4 && bytes !== 20)
    throw capitalError("PLAN_INVALID", "hashbytes must be 20 bytes for version <= 4");
  if (versionInt >= 5 && bytes !== 32)
    throw capitalError("PLAN_INVALID", "hashbytes must be 32 bytes for version 5 or 6");
  return { version, hashbytes };
}

function quoteWithdraw(ctx: AdapterContext, intent: Intent, reads: AdapterReads): Quote {
  if (intent.action !== "withdraw_sbtc") throw capitalError("UNSUPPORTED_ACTION", intent.action);
  const capability = capabilityFor("withdraw_sbtc", ctx.network, "sbtc");
  const sbtc = amount(token(ctx.network), intent.amount);
  assertPositive(sbtc, "withdrawal amount");
  if (sbtc.quantity <= WITHDRAWAL_DUST)
    throw capitalError("CAP_REACHED", `amount must be above dust ${WITHDRAWAL_DUST}`);
  const cap = parseQuantity(reads.emilyLimits.perWithdrawalCap);
  if (sbtc.quantity > cap) throw capitalError("CAP_REACHED", `above perWithdrawalCap ${cap}`);
  const maxFee = parseQuantity(intent.maxFee ?? "0");
  const locked = sbtc.quantity + maxFee;
  const btcOut = amount(bitcoinNative(ctx.network), sbtc.quantity);
  const executable = capability?.state === "enabled";
  const quote: Quote = {
    id: `q_wd_${ctx.now.getTime()}`,
    action: "withdraw_sbtc",
    marketId: SBTC_MARKET_WITHDRAW,
    network: ctx.network,
    input: [amount(token(ctx.network), locked)],
    expectedOutput: [btcOut],
    fees:
      maxFee > 0n
        ? [{ kind: "signer", amount: amount(token(ctx.network), maxFee), max: amount(token(ctx.network), maxFee) }]
        : [],
    snapshots: [`emily:${reads.emilyLimits.perWithdrawalCap}`],
    expiresAt: new Date(ctx.now.getTime() + 10 * 60_000).toISOString(),
    executable,
    warnings: executable
      ? ["Workflow completes only after signer acceptance and the Bitcoin payout, not at the Stacks request."]
      : [capability?.reason ?? "disabled"],
    registryVersion: ctx.registryVersion,
    adapterVersion: SBTC_WITHDRAW_VERSION,
    minimumOutput: btcOut,
  };
  return quote;
}

function buildWithdrawPlan(ctx: AdapterContext, quote: Quote, intent: Intent): Plan {
  if (!quote.executable)
    throw capitalError("CAPABILITY_DISABLED", quote.warnings.join("; ") || "withdrawal is not executable");
  if (intent.recipient === undefined) throw capitalError("PLAN_INVALID", "Bitcoin recipient is required");
  const recipient = decodeRecipient(intent.recipient);
  const maxFee = intent.maxFee ?? "0";
  const withdrawal = contract("sbtc", "sbtc-withdrawal", ctx.network);
  const sender = ctx.owner;
  if (sender === undefined) throw capitalError("PLAN_INVALID", "owner is required to set post conditions");
  return {
    id: `p_wd_${quote.id}`,
    quoteId: quote.id,
    network: ctx.network,
    registryVersion: ctx.registryVersion,
    adapterVersion: SBTC_WITHDRAW_VERSION,
    expiresAt: quote.expiresAt,
    reviewSummary: `Lock ${intent.amount} sBTC plus max fee ${maxFee} via initiate-withdrawal-request. Do not treat the Stacks tx as a Bitcoin payout.`,
    steps: [
      {
        id: "initiate_withdrawal",
        dependsOn: [],
        expectedAssetEffects: quote.expectedOutput,
        payload: {
          kind: "stacks_contract_call",
          contractId: withdrawal.contractId,
          functionName: "initiate-withdrawal-request",
          functionArgs: [
            { type: "uint", value: intent.amount },
            {
              type: "tuple",
              value: {
                version: { type: "buff", hex: recipient.version },
                hashbytes: { type: "buff", hex: recipient.hashbytes },
              },
            },
            { type: "uint", value: maxFee },
          ],
          postConditions: [
            {
              principal: sender,
              mode: "send_lte",
              amount: quote.input[0] ?? amount(token(ctx.network), intent.amount),
            },
          ],
          postConditionMode: "deny",
          network: ctx.network,
        },
      },
    ],
  };
}
