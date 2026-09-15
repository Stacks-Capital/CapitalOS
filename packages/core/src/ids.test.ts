import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAssetId, parseAssetId, sip10 } from "./ids.ts";
import { assertFinancialInt, parseQuantity } from "./amounts.ts";
import { requireNetwork } from "./network.ts";

describe("canonical identifiers", () => {
  it("round-trips a SIP-010 asset and rejects a ticker", () => {
    const asset = sip10("mainnet", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", "sbtc-token");
    const formatted = formatAssetId(asset);
    assert.equal(formatted, "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token");
    assert.deepEqual(parseAssetId(formatted), asset);
    assert.throws(() => parseAssetId("sBTC"), /Ticker alone is never an identifier/);
  });
});

describe("numeric rules", () => {
  it("accepts integer strings and rejects JavaScript numbers", () => {
    assert.equal(parseQuantity("1000"), 1000n);
    assert.throws(() => parseQuantity("1.5"), /base-10 integer string/);
    assert.throws(() => assertFinancialInt(1000, "amount"), /cannot use a JavaScript number/);
  });
});

describe("network", () => {
  it("fails closed when the network is missing", () => {
    assert.equal(requireNetwork("testnet"), "testnet");
    assert.throws(() => requireNetwork(undefined), /no default network/);
  });
});
