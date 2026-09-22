import { capabilityFor, findContract } from "@stacks-capital/config";
import type { Action, StacksNetwork } from "@stacks-capital/core";

/**
 * K28: Zest Protocol has no user-executable collateral / borrow / repay surface on reviewed
 * deployments. Earn is v0-vault-sbtc. User credit is Granite v0-8-market (K32). This module
 * certifies that split so Stacks Capital never invents a Zest borrow path.
 */

export const ZEST_CREDIT_ACTIONS = ["supply", "withdraw_supply", "borrow", "repay"] as const;
export type ZestCreditAction = (typeof ZEST_CREDIT_ACTIONS)[number];

export type ZestCreditAvailability = {
  action: ZestCreditAction;
  network: StacksNetwork;
  executable: false;
  state: "unavailable";
  reason: string;
  reviewedContracts: {
    earnVault: string | null;
    debtVault: string | null;
    supersededMarket: string | null;
  };
  redirect: {
    protocol: "granite";
    marketId: "granite.sbtc.isolated";
    note: string;
  };
};

export type ZestCreditLifecycle = {
  transferId: string;
  action: ZestCreditAction;
  network: StacksNetwork;
  state: "unavailable";
  complete: false;
  nextAction: "UNAVAILABLE";
  broadcastAllowed: false;
  availability: ZestCreditAvailability;
  warnings: string[];
};

const REASON =
  "Reviewed Zest deployments expose deposit/redeem on v0-vault-sbtc and system liquidity on v0-vault-usdc. There is no user collateral-add, borrow, or repay method on a live Zest market. v0-4-market is superseded. Do not treat zsBTC as Granite isolated collateral.";

export function zestCreditAvailability(network: StacksNetwork, action: ZestCreditAction): ZestCreditAvailability {
  const earn = findContract("zest", "v0-vault-sbtc", network);
  const debt = findContract("zest", "v0-vault-usdc", network);
  const superseded = findContract("zest", "v0-4-market", network);
  const earnCap = capabilityFor(action as Action, network, "zest");
  const reason =
    action === "supply" || action === "withdraw_supply"
      ? earnCap?.state === "enabled"
        ? "Zest supply/withdraw is the earn vault path (K27), not isolated collateral or borrow."
        : (earnCap?.reason ?? REASON)
      : REASON;

  return {
    action,
    network,
    executable: false,
    state: "unavailable",
    reason,
    reviewedContracts: {
      earnVault: earn?.contractId ?? null,
      debtVault: debt?.contractId ?? null,
      supersededMarket: superseded?.contractId ?? null,
    },
    redirect: {
      protocol: "granite",
      marketId: "granite.sbtc.isolated",
      note: "User collateral, borrow and repay are certified on Granite v0-8-market (K32), same deployer family but a different protocol and market id.",
    },
  };
}

export function zestCreditTransferId(network: StacksNetwork, action: ZestCreditAction, idempotencyKey: string): string {
  return `${network}:zest-credit:${action}:${idempotencyKey}`;
}

/** Always fail-closed. Never returns an executable plan or allows broadcast. */
export function evaluateZestCredit(input: {
  action: ZestCreditAction;
  network: StacksNetwork;
  idempotencyKey: string;
}): ZestCreditLifecycle {
  const availability = zestCreditAvailability(input.network, input.action);
  return {
    transferId: zestCreditTransferId(input.network, input.action, input.idempotencyKey),
    action: input.action,
    network: input.network,
    state: "unavailable",
    complete: false,
    nextAction: "UNAVAILABLE",
    broadcastAllowed: false,
    availability,
    warnings: [availability.reason, availability.redirect.note],
  };
}
