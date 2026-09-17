import type { WorkflowId } from "./ids.ts";
import type { StacksNetwork } from "./network.ts";

export type ChainBlock = {
  chain: "bitcoin" | "stacks";
  network: StacksNetwork;
  height: number;
  hash: string;
  parentHash: string;
  canonical: boolean;
  observedAt: string;
  source: string;
};

export type RawEvent = {
  id: string;
  chain: "bitcoin" | "stacks";
  network: StacksNetwork;
  blockHash: string;
  payload: string;
  canonical: boolean;
  observedAt: string;
  source: string;
};

export type IngestionCheckpoint = {
  chain: "bitcoin" | "stacks";
  network: StacksNetwork;
  height: number;
  hash: string;
};

export type CanonicalActivity = {
  id: string;
  workflowId?: WorkflowId;
  kind: string;
  blockHash: string;
  canonical: boolean;
};

export type IngestionState = {
  blocks: ChainBlock[];
  events: RawEvent[];
  checkpoint: IngestionCheckpoint | null;
  activities: CanonicalActivity[];
};

export function emptyIngestion(): IngestionState {
  return { blocks: [], events: [], checkpoint: null, activities: [] };
}

export function applyBlock(state: IngestionState, block: ChainBlock, events: RawEvent[]): IngestionState {
  if (state.checkpoint !== null && block.parentHash !== state.checkpoint.hash) {
    throw new Error(`Block ${block.hash} does not continue checkpoint ${state.checkpoint.hash}`);
  }
  return {
    blocks: [...state.blocks, { ...block, canonical: true }],
    events: [...state.events, ...events.map((event) => ({ ...event, canonical: true }))],
    checkpoint: {
      chain: block.chain,
      network: block.network,
      height: block.height,
      hash: block.hash,
    },
    activities: state.activities,
  };
}

export function applyReorg(state: IngestionState, commonAncestorHash: string): IngestionState {
  const ancestor = state.blocks.find((block) => block.hash === commonAncestorHash);
  if (ancestor === undefined) throw new Error(`Unknown ancestor ${commonAncestorHash}`);

  return {
    blocks: state.blocks.map((block) => (block.height > ancestor.height ? { ...block, canonical: false } : block)),
    events: state.events.map((event) => {
      const block = state.blocks.find((candidate) => candidate.hash === event.blockHash);
      if (block !== undefined && block.height > ancestor.height) return { ...event, canonical: false };
      return event;
    }),
    checkpoint: {
      chain: ancestor.chain,
      network: ancestor.network,
      height: ancestor.height,
      hash: ancestor.hash,
    },
    activities: state.activities.map((activity) => {
      const event = state.events.find((candidate) => candidate.id === activity.id);
      const block = event ? state.blocks.find((candidate) => candidate.hash === event.blockHash) : undefined;
      if (block !== undefined && block.height > ancestor.height) return { ...activity, canonical: false };
      return activity;
    }),
  };
}
