import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { type Cache, type CapitalClient, cacheKey, createCache, type Market, type Page } from "@stacks-capital/client";
import { JSDOM } from "jsdom";
import { createElement, type ReactNode } from "react";
import { CapitalProvider } from "./context.ts";
import { useMarkets, useWorkflow } from "./hooks.ts";

// React needs a document. jsdom gives one without a browser.
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
// navigator is a getter on globalThis, so it needs defineProperty rather than assignment.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

after(() => dom.window.close());

const MARKET: Market = {
  id: "zest.sbtc.vault",
  network: "mainnet",
  protocol: "zest",
  suppliedAssetId: null,
  receiptAssetId: null,
  capabilities: [],
};

const page = (id: string): Page<Market> => ({
  items: [{ ...MARKET, id }],
  nextCursor: null,
  context: {
    requestId: "req_1",
    network: "mainnet",
    observedAt: "2026-09-18T09:00:00.000Z",
    stale: false,
    warnings: [],
  },
});

function fakeClient(overrides: Partial<CapitalClient> = {}): CapitalClient {
  const client = {
    network: "mainnet" as const,
    hasSession: false,
    markets: async () => page("zest.sbtc.vault"),
    allMarkets: async () => [MARKET],
    capabilities: async () => ({ items: [], nextCursor: null, context: page("x").context }),
    workflow: async () => ({ data: { id: "wf_1" }, context: page("x").context }),
    challenge: async () => ({ data: { nonceId: "non_1" }, context: page("x").context }),
    verify: async () => ({ data: { token: "ses_1.secret" }, context: page("x").context }),
    withSession: () => client,
    ...overrides,
  } as unknown as CapitalClient;
  return client;
}

/** Renders a tree and returns helpers to change its props and read what the hook produced. */
function mount(element: (props: { address: string | null }) => ReactNode, address: string | null = "SP1") {
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  const render = (next: string | null) => act(() => void root.render(element({ address: next })));
  render(address);
  return {
    async set(next: string | null) {
      render(next);
      await act(async () => {});
    },
    async settle() {
      await act(async () => {});
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

function harness(client: CapitalClient, cache: Cache, useHook: () => unknown) {
  const results: unknown[] = [];
  const Probe = () => {
    results.push(useHook());
    return null;
  };
  const view = mount(({ address }) =>
    createElement(CapitalProvider, { client, cache, address }, createElement(Probe, null)),
  );
  return { results, view, last: () => results.at(-1) };
}

type MarketsResult = { status: string; data?: Page<Market>; isLoading: boolean; refresh: () => Promise<void> };

describe("useMarkets", () => {
  it("loads once and shares the entry with the cache", async () => {
    const cache = createCache();
    let calls = 0;
    const client = fakeClient({
      markets: async () => {
        calls += 1;
        return page("zest.sbtc.vault");
      },
    });

    const { view, last } = harness(client, cache, () => useMarkets());
    assert.equal((last() as MarketsResult).status, "loading");
    await view.settle();

    const result = last() as MarketsResult;
    assert.equal(result.status, "ready");
    assert.deepEqual(
      result.data?.items.map((market) => market.id),
      ["zest.sbtc.vault"],
    );
    assert.equal(calls, 1);
    assert.equal(cache.get(cacheKey({ network: "mainnet", address: "SP1" }, "markets")).status, "ready");
    view.unmount();
  });

  it("reads again when asked to refresh", async () => {
    const cache = createCache();
    let calls = 0;
    const client = fakeClient({
      markets: async () => {
        calls += 1;
        return page(`market_${calls}`);
      },
    });

    const { view, last } = harness(client, cache, () => useMarkets());
    await view.settle();
    await act(async () => {
      await (last() as MarketsResult).refresh();
    });
    assert.equal(calls, 2);
    assert.deepEqual(
      (last() as MarketsResult).data?.items.map((market) => market.id),
      ["market_2"],
    );
    view.unmount();
  });

  it("reports a failed read without losing the last good data", async () => {
    const cache = createCache({ staleMs: 0 });
    let calls = 0;
    const client = fakeClient({
      markets: async () => {
        calls += 1;
        if (calls > 1) throw new Error("provider down");
        return page("zest.sbtc.vault");
      },
    });

    const { view, last } = harness(client, cache, () => useMarkets());
    await view.settle();
    await act(async () => {
      await (last() as MarketsResult).refresh();
    });
    const result = last() as MarketsResult & { error?: Error };
    assert.equal(result.status, "error");
    assert.deepEqual(
      result.data?.items.map((market) => market.id),
      ["zest.sbtc.vault"],
    );
    assert.match(result.error?.message ?? "", /provider down/);
    view.unmount();
  });
});

describe("cache isolation", () => {
  it("gives each address its own entry and forgets the old one on a wallet switch", async () => {
    const cache = createCache();
    const seen: string[] = [];
    const client = fakeClient({
      markets: async () => {
        seen.push("read");
        return page("zest.sbtc.vault");
      },
    });

    const { view } = harness(client, cache, () => useMarkets());
    await view.settle();
    assert.deepEqual(cache.keys(), [cacheKey({ network: "mainnet", address: "SP1" }, "markets")]);

    await view.set("SP2");
    // The new address reads for itself, and the old address's entry is gone.
    assert.deepEqual(cache.keys(), [cacheKey({ network: "mainnet", address: "SP2" }, "markets")]);
    assert.equal(seen.length, 2);
    view.unmount();
  });

  it("drops a quote from the previous wallet", async () => {
    const cache = createCache();
    const quoteKey = cacheKey({ network: "mainnet", address: "SP1" }, "quote", { marketId: "zest.sbtc.vault" });
    cache.set(quoteKey, { id: "quote_for_SP1" });

    const { view } = harness(fakeClient(), cache, () => useMarkets());
    await view.settle();
    assert.equal(cache.get(quoteKey).status, "ready");

    await view.set("SP2");
    assert.equal(cache.get(quoteKey).status, "idle");
    view.unmount();
  });

  it("keeps signed out data separate from a signed in address", async () => {
    const cache = createCache();
    const { view } = harness(fakeClient(), cache, () => useMarkets());
    await view.settle();

    await view.set(null);
    assert.deepEqual(cache.keys(), [cacheKey({ network: "mainnet", address: null }, "markets")]);
    view.unmount();
  });
});

describe("useWorkflow", () => {
  it("waits until there is an id to read", async () => {
    const cache = createCache();
    let calls = 0;
    const client = fakeClient({
      workflow: async (id: string) => {
        calls += 1;
        return { data: { id }, context: page("x").context } as never;
      },
    });

    let id: string | null = null;
    const { view, last } = harness(client, cache, () => useWorkflow(id));
    await view.settle();
    assert.equal((last() as MarketsResult).status, "idle");
    assert.equal(calls, 0);

    id = "wf_1";
    await view.set("SP1");
    assert.equal(calls, 1);
    assert.equal(
      cache.get(cacheKey({ network: "mainnet", address: "SP1" }, "workflow", { id: "wf_1" })).status,
      "ready",
    );
    view.unmount();
  });
});

describe("refresh", () => {
  it("acts on the current key even when called from an earlier render", async () => {
    const cache = createCache({ staleMs: 60_000 });
    const reads: (string | undefined)[] = [];
    const client = fakeClient({
      workflow: async (id: string) => {
        reads.push(id);
        return { data: { id, state: `read ${reads.length}` }, context: page("x").context } as never;
      },
    });

    let id: string | null = null;
    const { view, results } = harness(client, cache, () => useWorkflow(id));
    await view.settle();
    // Keep the refresh from a render where there was no workflow yet, as an async handler would.
    const staleRefresh = (results.at(-1) as MarketsResult).refresh;

    id = "wf_7";
    await view.set("SP1");
    assert.deepEqual(reads, ["wf_7"]);

    await act(async () => {
      await staleRefresh();
    });
    assert.deepEqual(reads, ["wf_7", "wf_7"]);
    view.unmount();
  });
});

describe("provider", () => {
  it("refuses to work outside a provider", () => {
    const Probe = () => {
      useMarkets();
      return null;
    };
    assert.throws(() => mount(() => createElement(Probe, null)), /must be used inside a CapitalProvider/);
  });
});
