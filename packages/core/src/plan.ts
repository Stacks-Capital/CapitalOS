import type { AssetAmount } from "./amounts.ts";
import type { PlanId, QuoteId, StepId } from "./ids.ts";
import type { BitcoinNetworkKind, StacksNetwork } from "./network.ts";

export type ClarityValue =
  | { type: "uint"; value: string }
  | { type: "principal"; value: string }
  | { type: "buff"; hex: string }
  | { type: "tuple"; value: Record<string, ClarityValue> }
  | { type: "none" }
  | { type: "some"; value: ClarityValue };

export type PostCondition = {
  principal: string;
  mode: "send_lte" | "send_eq" | "send_gte" | "receive_gte";
  amount: AssetAmount;
};

export type BitcoinDepositPayload = {
  kind: "bitcoin_deposit";
  amountSats: string;
  stacksRecipient: string;
  bitcoinNetwork: BitcoinNetworkKind;
  reclaimLockTime: number;
  maxSignerFeeSats: string;
  emilyNotifyPath: string;
};

export type StacksCallPayload = {
  kind: "stacks_contract_call";
  contractId: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
  postConditionMode: "deny" | "allow";
  network: StacksNetwork;
};

export type UnsignedPayload = BitcoinDepositPayload | StacksCallPayload;

export type PlanStep = {
  id: StepId;
  payload: UnsignedPayload;
  expectedAssetEffects: AssetAmount[];
  dependsOn: StepId[];
};

export type Plan = {
  id: PlanId;
  quoteId: QuoteId;
  network: StacksNetwork;
  registryVersion: string;
  adapterVersion: string;
  steps: PlanStep[];
  expiresAt: string;
  reviewSummary: string;
};

export type PlanValidation = {
  ok: boolean;
  reasons: string[];
};
