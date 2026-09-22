import type { Chain, StacksNetwork } from "./network.ts";

export type NativeIdentity = { kind: "native"; symbol: "btc" | "stx" };
export type ContractIdentity = { kind: "contract"; principal: string; assetName: string };
export type AssetIdentity = NativeIdentity | ContractIdentity;

export type AssetId = {
  chain: Chain;
  network: StacksNetwork;
  identity: AssetIdentity;
};

export type DeploymentId = {
  protocol: string;
  network: StacksNetwork;
  contractId: string;
  revision: string;
};

export type MarketId = string;
export type PositionKind =
  | "wallet"
  | "supplied"
  | "lp"
  | "collateral"
  | "debt"
  | "locked"
  | "pending_deposit"
  | "pending_withdrawal"
  | "staked";

export type PositionId = {
  owner: string;
  deployment: DeploymentId;
  marketId: MarketId;
  kind: PositionKind;
  protocolKey: string;
};

export type WorkflowId = string;
export type StepId = string;
export type QuoteId = string;
export type PlanId = string;

export function formatAssetId(asset: AssetId): string {
  if (asset.identity.kind === "native") {
    return `${asset.chain}:${asset.network}:native:${asset.identity.symbol}`;
  }
  return `${asset.chain}:${asset.network}:contract:${asset.identity.principal}:${asset.identity.assetName}`;
}

export function parseAssetId(value: string): AssetId {
  const parts = value.split(":");
  const chain = parts[0];
  const network = parts[1];
  const kind = parts[2];
  if ((chain !== "bitcoin" && chain !== "stacks") || (network !== "mainnet" && network !== "testnet")) {
    throw new Error(`Ticker alone is never an identifier: ${value}`);
  }
  if (kind === "native") {
    const symbol = parts[3];
    if (symbol !== "btc" && symbol !== "stx") throw new Error(`Unknown native asset: ${value}`);
    return { chain, network, identity: { kind: "native", symbol } };
  }
  if (kind === "contract" && parts[3] !== undefined && parts[4] !== undefined) {
    return {
      chain,
      network,
      identity: { kind: "contract", principal: parts[3], assetName: parts.slice(4).join(":") },
    };
  }
  throw new Error(`Ticker alone is never an identifier: ${value}`);
}

export function formatDeploymentId(deployment: DeploymentId): string {
  return `${deployment.protocol}:${deployment.network}:${deployment.contractId}@${deployment.revision}`;
}

export function sameAsset(left: AssetId, right: AssetId): boolean {
  return formatAssetId(left) === formatAssetId(right);
}

export function bitcoinNative(network: StacksNetwork): AssetId {
  return { chain: "bitcoin", network, identity: { kind: "native", symbol: "btc" } };
}

export function stacksNative(network: StacksNetwork): AssetId {
  return { chain: "stacks", network, identity: { kind: "native", symbol: "stx" } };
}

export function sip10(network: StacksNetwork, principal: string, assetName: string): AssetId {
  return { chain: "stacks", network, identity: { kind: "contract", principal, assetName } };
}
