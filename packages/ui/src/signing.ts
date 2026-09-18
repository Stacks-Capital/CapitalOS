import type { PlanStep } from "@stacks-capital/client";
import { parseAssetId, type StacksNetwork } from "@stacks-capital/core";
import { classifyWalletError, type WalletId } from "@stacks-capital/wallets";
import { Cl, type ClarityValue as StacksClarityValue, cvToHex } from "@stacks/transactions";

type PlanClarityValue =
  | { type: "uint"; value: string }
  | { type: "principal"; value: string }
  | { type: "buff"; hex: string }
  | { type: "tuple"; value: Record<string, PlanClarityValue> }
  | { type: "none" }
  | { type: "some"; value: PlanClarityValue };

type PlanPostCondition = {
  principal: string;
  mode: "send_lte" | "send_eq" | "send_gte" | "receive_gte";
  amount: { asset: string; quantity: string };
};

type StacksCall = {
  kind: "stacks_contract_call";
  contractId: string;
  functionName: string;
  functionArgs: PlanClarityValue[];
  postConditions: PlanPostCondition[];
  postConditionMode: "deny" | "allow";
  network: StacksNetwork;
};

export type WalletRequest = {
  method: "stx_callContract";
  params: {
    contract: string;
    functionName: string;
    functionArgs: string[];
    postConditions: PostConditionRequest[];
    postConditionMode: "deny" | "allow";
    network: StacksNetwork;
  };
};

export type PostConditionRequest =
  | { type: "stx-postcondition"; address: string; condition: string; amount: string }
  | { type: "ft-postcondition"; address: string; condition: string; amount: string; asset: string };

const CONDITIONS: Record<PlanPostCondition["mode"], string> = {
  send_lte: "lte",
  send_eq: "eq",
  send_gte: "gte",
  receive_gte: "gte",
};

export function encodeArgument(value: PlanClarityValue): string {
  return cvToHex(toClarity(value));
}

function toClarity(value: PlanClarityValue): StacksClarityValue {
  switch (value.type) {
    case "uint":
      return Cl.uint(BigInt(value.value));
    case "principal":
      return Cl.principal(value.value);
    case "buff":
      return Cl.bufferFromHex(value.hex.replace(/^0x/, ""));
    case "none":
      return Cl.none();
    case "some":
      return Cl.some(toClarity(value.value));
    case "tuple":
      return Cl.tuple(Object.fromEntries(Object.entries(value.value).map(([key, entry]) => [key, toClarity(entry)])));
    default:
      throw new Error(`Plan step uses a value this app cannot encode: ${JSON.stringify(value)}`);
  }
}

export function encodePostCondition(condition: PlanPostCondition): PostConditionRequest {
  const asset = parseAssetId(condition.amount.asset);
  const shared = {
    address: condition.principal,
    condition: CONDITIONS[condition.mode],
    amount: condition.amount.quantity,
  };
  if (asset.identity.kind === "native") return { type: "stx-postcondition", ...shared };
  return {
    type: "ft-postcondition",
    ...shared,
    asset: `${asset.identity.principal}::${asset.identity.assetName}`,
  };
}

/** Turns a plan step into the exact request the wallet is asked to sign. Nothing is added or dropped. */
export function toWalletRequest(step: PlanStep): WalletRequest {
  if (step.payload.kind !== "stacks_contract_call") {
    throw new Error(`This app can only sign Stacks contract calls, not ${step.payload.kind}`);
  }
  const payload = step.payload as unknown as StacksCall;
  return {
    method: "stx_callContract",
    params: {
      contract: payload.contractId,
      functionName: payload.functionName,
      functionArgs: payload.functionArgs.map(encodeArgument),
      postConditions: payload.postConditions.map(encodePostCondition),
      postConditionMode: payload.postConditionMode,
      network: payload.network,
    },
  };
}

export type WalletAnswer =
  | { kind: "answered"; result: unknown }
  /** The user said no in the wallet. Nothing was signed or sent, so the step can simply be asked again. */
  | { kind: "rejected"; message: string }
  /** The wallet failed in a way that does not say whether anything was sent. That has to be recorded, not retried. */
  | { kind: "unknown"; result: { error: string } };

/**
 * Asks the wallet to sign one plan step and sorts the answer into what it means (I02 findings:
 * Leather rejects with 4001, Xverse with -32000). A rejection is kept out of the workflow, because
 * recording it as an unknown broadcast would send the user to support for something they chose.
 */
export async function askWallet(
  provider: { request(method: string, params?: unknown): Promise<unknown> },
  walletId: WalletId,
  request: WalletRequest,
): Promise<WalletAnswer> {
  try {
    return { kind: "answered", result: await provider.request(request.method, request.params) };
  } catch (error) {
    if (classifyWalletError(walletId, error) === "USER_REJECTED") {
      return { kind: "rejected", message: "You declined in your wallet. Nothing was sent." };
    }
    const message = (error as { message?: unknown } | null)?.message;
    return { kind: "unknown", result: { error: typeof message === "string" ? message : "The wallet did not answer" } };
  }
}
