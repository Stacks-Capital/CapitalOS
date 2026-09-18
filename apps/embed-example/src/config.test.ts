import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readEmbedConfig } from "./config.ts";

describe("embed configuration", () => {
  it("reads the publishable values a partner page needs", () => {
    assert.deepEqual(readEmbedConfig({ VITE_CLIENT_ID: "pk_acme_live", VITE_NETWORK: "testnet" }), {
      apiBaseUrl: "http://127.0.0.1:3000",
      clientId: "pk_acme_live",
      network: "testnet",
    });
  });

  it("refuses an API key or a session token anywhere in the browser configuration", () => {
    const key = `key_0123456789abcdef.${"A".repeat(43)}`;
    const session = `ses_0123456789abcdef.${"B".repeat(43)}`;
    assert.throws(() => readEmbedConfig({ VITE_CLIENT_ID: "pk_acme", VITE_API_KEY: key }), /holds a secret/);
    assert.throws(() => readEmbedConfig({ VITE_CLIENT_ID: "pk_acme", VITE_TOKEN: session }), /holds a secret/);
  });

  it("ignores values that never reach the bundle", () => {
    const key = `key_0123456789abcdef.${"A".repeat(43)}`;
    assert.equal(readEmbedConfig({ VITE_CLIENT_ID: "pk_acme", SERVER_ONLY_KEY: key }).clientId, "pk_acme");
  });

  it("needs a publishable client id and a known network", () => {
    assert.throws(() => readEmbedConfig({}), /publishable client id/);
    assert.throws(() => readEmbedConfig({ VITE_CLIENT_ID: "key_nope" }), /publishable client id/);
    assert.throws(() => readEmbedConfig({ VITE_CLIENT_ID: "pk_acme", VITE_NETWORK: "devnet" }), /mainnet or testnet/);
  });
});
