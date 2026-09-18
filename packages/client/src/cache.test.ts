import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheKey, createCache, sameScope, scopeKey } from "./cache.ts";

const MAINNET = { network: "mainnet", address: "SP1" } as const;
const OTHER_WALLET = { network: "mainnet", address: "SP2" } as const;
const TESTNET = { network: "testnet", address: "SP1" } as const;

function clock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("cache keys", () => {
  it("separate networks, addresses and signed out users", () => {
    assert.equal(scopeKey(MAINNET), "mainnet|SP1");
    assert.equal(scopeKey({ network: "mainnet", address: null }), "mainnet|anonymous");
    assert.notEqual(cacheKey(MAINNET, "markets"), cacheKey(TESTNET, "markets"));
    assert.notEqual(cacheKey(MAINNET, "markets"), cacheKey(OTHER_WALLET, "markets"));
    assert.equal(sameScope(MAINNET, { network: "mainnet", address: "SP1" }), true);
    assert.equal(sameScope(MAINNET, OTHER_WALLET), false);
  });

  it("are stable whatever order the parameters are written in, and ignore missing ones", () => {
    assert.equal(
      cacheKey(MAINNET, "markets", { limit: 20, cursor: "abc" }),
      cacheKey(MAINNET, "markets", { cursor: "abc", limit: 20 }),
    );
    assert.equal(cacheKey(MAINNET, "markets", { limit: undefined }), cacheKey(MAINNET, "markets"));
    assert.equal(cacheKey(MAINNET, "workflow", { id: "wf_1" }), "mainnet|SP1|workflow?id=wf_1");
  });
});

describe("loading", () => {
  it("stores the result and tells subscribers", async () => {
    const cache = createCache();
    const key = cacheKey(MAINNET, "markets");
    let notified = 0;
    cache.subscribe(key, () => {
      notified += 1;
    });

    assert.deepEqual(cache.get(key), { status: "idle", data: undefined, error: undefined, updatedAt: undefined });
    const data = await cache.load(key, async () => ["zest.sbtc.vault"]);
    assert.deepEqual(data, ["zest.sbtc.vault"]);
    assert.equal(cache.get<string[]>(key).status, "ready");
    assert.deepEqual(cache.get<string[]>(key).data, ["zest.sbtc.vault"]);
    // Loading, then ready.
    assert.equal(notified, 2);
  });

  it("serves a fresh entry without asking again, and reloads once it is stale", async () => {
    const time = clock();
    const cache = createCache({ now: time.now, staleMs: 1_000 });
    const key = cacheKey(MAINNET, "markets");
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return loads;
    };

    assert.equal(await cache.load(key, loader), 1);
    assert.equal(await cache.load(key, loader), 1);
    time.advance(1_001);
    assert.equal(await cache.load(key, loader), 2);
    assert.equal(await cache.load(key, loader, { force: true }), 3);
    assert.equal(loads, 3);
  });

  it("joins callers that ask for the same key at the same time", async () => {
    const cache = createCache();
    const key = cacheKey(MAINNET, "markets");
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "once";
    };

    const [first, second] = await Promise.all([cache.load(key, loader), cache.load(key, loader)]);
    assert.deepEqual([first, second], ["once", "once"]);
    assert.equal(loads, 1);
  });

  it("keeps the last good data when a reload fails, and reports the error", async () => {
    const cache = createCache({ staleMs: 0 });
    const key = cacheKey(MAINNET, "markets");
    await cache.load(key, async () => "good");
    await assert.rejects(
      cache.load(key, async () => {
        throw new Error("provider down");
      }),
    );
    const entry = cache.get<string>(key);
    assert.equal(entry.status, "error");
    assert.equal(entry.data, "good");
    assert.match((entry.error as Error).message, /provider down/);
  });
});

describe("isolation", () => {
  it("keeps one address's data out of another's", async () => {
    const cache = createCache();
    await cache.load(cacheKey(MAINNET, "positions"), async () => "SP1 positions");
    await cache.load(cacheKey(OTHER_WALLET, "positions"), async () => "SP2 positions");
    assert.equal(cache.get<string>(cacheKey(MAINNET, "positions")).data, "SP1 positions");
    assert.equal(cache.get<string>(cacheKey(OTHER_WALLET, "positions")).data, "SP2 positions");
  });

  it("drops everything outside the current network and address on a switch", async () => {
    const cache = createCache();
    await cache.load(cacheKey(MAINNET, "positions"), async () => "SP1");
    await cache.load(cacheKey(TESTNET, "positions"), async () => "testnet SP1");
    await cache.load(cacheKey(OTHER_WALLET, "positions"), async () => "SP2");

    assert.equal(cache.keepScope(OTHER_WALLET), 2);
    assert.deepEqual(cache.keys(), [cacheKey(OTHER_WALLET, "positions")]);
    assert.equal(cache.get(cacheKey(MAINNET, "positions")).status, "idle");
  });

  it("drops quotes, which belong to one address and expire", async () => {
    const cache = createCache();
    await cache.load(cacheKey(MAINNET, "quote", { marketId: "zest.sbtc.vault" }), async () => "quote for SP1");
    await cache.load(cacheKey(MAINNET, "markets"), async () => "markets");

    assert.equal(cache.dropQuotes(), 1);
    assert.equal(cache.get(cacheKey(MAINNET, "quote", { marketId: "zest.sbtc.vault" })).status, "idle");
    assert.equal(cache.get<string>(cacheKey(MAINNET, "markets")).data, "markets");
  });

  it("tells subscribers when their entry is dropped", async () => {
    const cache = createCache();
    const key = cacheKey(MAINNET, "quote");
    await cache.load(key, async () => "quote");
    let notified = 0;
    cache.subscribe(key, () => {
      notified += 1;
    });
    cache.dropQuotes();
    assert.equal(notified, 1);
  });

  it("does not let a load that was dropped mid flight come back", async () => {
    const cache = createCache();
    const key = cacheKey(MAINNET, "quote");
    let release = (_value: string) => {};
    const pending = cache.load(
      key,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    cache.dropQuotes();
    release("late answer");
    await pending;
    assert.equal(cache.get(key).status, "idle");
    assert.deepEqual(cache.keys(), []);
  });

  it("stops notifying after unsubscribe", async () => {
    const cache = createCache();
    const key = cacheKey(MAINNET, "markets");
    let notified = 0;
    const stop = cache.subscribe(key, () => {
      notified += 1;
    });
    stop();
    await cache.load(key, async () => "markets");
    assert.equal(notified, 0);
  });
});
