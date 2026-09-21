import { capabilityFor } from "@stacks-capital/config";
import type { StacksNetwork } from "@stacks-capital/core";

/**
 * K33: Native Bitcoin / PoX staking stays capability-disabled until lockup signing is verified (K16).
 * This module certifies the unavailable state so UI and partners never see a fake executable stake path.
 */

export const STAKING_ACTIONS = ["stake"] as const;
export type StakingAction = (typeof STAKING_ACTIONS)[number];

export type StakingAvailability = {
  action: StakingAction;
  network: StacksNetwork;
  executable: false;
  state: "unavailable";
  reason: string;
  distinctions: string[];
};

export type StakingLifecycle = {
  transferId: string;
  action: StakingAction;
  network: StacksNetwork;
  state: "unavailable";
  complete: false;
  nextAction: "UNAVAILABLE";
  broadcastAllowed: false;
  availability: StakingAvailability;
  warnings: string[];
};

const DISTINCTIONS = [
  "Native Bitcoin / PoX staking locks L1 Bitcoin. It is not sBTC DeFi supply.",
  "zsBTC earn receipts are not staking positions.",
  "pox-5 also exposes unstake / unstake-sbtc; those stay disabled with the same lockup-signing gate.",
  "Wallet lockup-signing evidence is still missing; Capital OS will not invent a stake plan.",
];

export function stakingAvailability(network: StacksNetwork, action: StakingAction): StakingAvailability {
  const capability = capabilityFor(action, network);
  return {
    action,
    network,
    executable: false,
    state: "unavailable",
    reason: capability?.reason ?? "Staking remains disabled until Bitcoin L1 lockup signing is verified",
    distinctions: DISTINCTIONS,
  };
}

export function evaluateStaking(input: {
  action: StakingAction;
  network: StacksNetwork;
  idempotencyKey: string;
}): StakingLifecycle {
  const availability = stakingAvailability(input.network, input.action);
  return {
    transferId: `${input.network}:staking:${input.action}:${input.idempotencyKey}`,
    action: input.action,
    network: input.network,
    state: "unavailable",
    complete: false,
    nextAction: "UNAVAILABLE",
    broadcastAllowed: false,
    availability,
    warnings: [availability.reason, ...availability.distinctions],
  };
}
