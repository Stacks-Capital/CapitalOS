import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identifyBitcoinNetwork, parseNetworks, pickRateLimitHeaders, redact } from "./lib.ts";

describe("parseNetworks", () => {
  it("accepts testnet, mainnet and both", () => {
    assert.deepEqual(parseNetworks("testnet"), ["testnet"]);
    assert.deepEqual(parseNetworks("mainnet"), ["mainnet"]);
    assert.deepEqual(parseNetworks("both"), ["testnet", "mainnet"]);
  });

  it("fails closed when the network is missing or unknown", () => {
    assert.throws(() => parseNetworks(undefined), /no default network/);
    assert.throws(() => parseNetworks(""), /no default network/);
    assert.throws(() => parseNetworks("devnet"), /Unknown network/);
  });
});

describe("identifyBitcoinNetwork", () => {
  it("recognizes known genesis hashes", () => {
    assert.equal(identifyBitcoinNetwork("0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206"), "regtest");
    assert.equal(identifyBitcoinNetwork(" 000000000019D6689C085AE165831E934FF763AE46A2A6C172B3F1B60A8CE26F\n"), "mainnet");
  });

  it("returns unknown for anything else", () => {
    assert.equal(identifyBitcoinNetwork("<!doctype html>"), "unknown");
  });
});

describe("pickRateLimitHeaders", () => {
  it("keeps only rate limit and retry headers", () => {
    const headers = new Headers({
      "x-ratelimit-limit-minute": "50",
      "ratelimit-remaining": "19",
      "retry-after": "60",
      "content-type": "application/json",
    });
    assert.deepEqual(pickRateLimitHeaders(headers), {
      "x-ratelimit-limit-minute": "50",
      "ratelimit-remaining": "19",
      "retry-after": "60",
    });
  });

  it("returns an empty object when a provider sends none", () => {
    assert.deepEqual(pickRateLimitHeaders(new Headers({ "cache-control": "no-cache" })), {});
  });
});

describe("redact", () => {
  it("removes every occurrence of each secret", () => {
    assert.equal(redact("key abc123 and abc123 again", ["abc123"]), "key [redacted] and [redacted] again");
  });

  it("leaves text alone when no secret is set", () => {
    assert.equal(redact("nothing to hide", [undefined, ""]), "nothing to hide");
  });
});
