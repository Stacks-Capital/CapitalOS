import type { StacksNetwork } from "@stacks-capital/core";

export const SCHEMA_VERSION = "1.0";

export type CapabilityState = "enabled" | "read_only" | "paused" | "disabled";

export type Capability = {
  action: string;
  state: CapabilityState;
  reason: string;
  contractId: string;
  deploymentId: string | null;
  adapterVersion: string;
  registryVersion: string;
};

export type MarketCapability = Capability & { marketId: string };

export type Market = {
  id: string;
  network: StacksNetwork;
  protocol: string;
  suppliedAssetId: string | null;
  receiptAssetId: string | null;
  capabilities: Capability[];
};

/** Every answer carries where it came from and how fresh it is (page 01 envelope). */
export type ResponseContext = {
  requestId: string;
  network: StacksNetwork;
  observedAt: string;
  stale: boolean;
  warnings: string[];
  blockHeight?: number;
  blockHash?: string;
};

export type Page<T> = { items: T[]; nextCursor: string | null; context: ResponseContext };
export type Result<T> = { data: T; context: ResponseContext };

export type Challenge = { nonceId: string; message: string; expiresAt: string };
export type Session = { token: string; sessionId: string; address: string; expiresAt: string };

export type WorkflowTransition = {
  sequence: number;
  from: string;
  to: string;
  reason: string;
  actor: string;
  evidence: string;
  at: string;
};

export type Workflow = {
  id: string;
  network: StacksNetwork;
  state: string;
  nextAction: string;
  quoteId: string | null;
  planId: string | null;
  ownerAddress: string | null;
  createdAt: string;
  updatedAt: string;
  transitions: WorkflowTransition[];
};
