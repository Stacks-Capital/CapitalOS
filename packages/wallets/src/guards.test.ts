import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyWalletError, networkGuard } from "./guards.ts";

describe("wallet guards", () => {
  it("requires Bitcoin regtest addresses on Stacks testnet", () => {
    assert.equal(
      networkGuard("testnet", {
        stx: "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0",
        btc: ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"],
      })?.code,
      "NETWORK_MISMATCH",
    );
    assert.equal(
      networkGuard("testnet", {
        stx: "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0",
        btc: ["bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"],
      }),
      null,
    );
  });

  it("maps Leather 4001 and Xverse -32000 to USER_REJECTED", () => {
    assert.equal(classifyWalletError("leather", { code: 4001 }), "USER_REJECTED");
    assert.equal(classifyWalletError("xverse", { code: -32000 }), "USER_REJECTED");
    assert.equal(classifyWalletError("xverse", { code: -32001 }), "UNSUPPORTED_WALLET");
  });
});
