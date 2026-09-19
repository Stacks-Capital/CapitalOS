import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readConfig, testnetNote } from "./config.ts";

describe("web config", () => {
  const env = { VITE_CLIENT_ID: "pk_fixture_sandbox" };

  it("starts on mainnet and can be pointed at testnet", () => {
    assert.equal(readConfig(env).network, "mainnet");
    assert.equal(readConfig({ ...env, VITE_NETWORK: "testnet" }).network, "testnet");
    assert.equal(readConfig({ ...env, VITE_NETWORK: "mainnet" }).apiBaseUrl, "http://127.0.0.1:3000");
  });

  it("refuses an unknown network instead of picking one", () => {
    assert.throws(() => readConfig({ ...env, VITE_NETWORK: "devnet" }), /no default network/);
  });

  it("says testnet writes stay off", () => {
    assert.equal(testnetNote("mainnet"), null);
    assert.match(testnetNote("testnet") ?? "", /disabled/);
  });
});
