import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bitcoinAddressKind,
  classifyWalletError,
  networkGuard,
  stacksAddressNetwork,
  walletOutcome,
} from "./guards.ts";

const LEATHER_TESTNET_STX = "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0";
const XVERSE_TESTNET_STX = "ST1D9X179MAJ9XA7KHSZJ48CN39DVB6TAQDYST34R";
const MAINNET_STX = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";

describe("stacksAddressNetwork", () => {
  it("reads the network from real addresses", () => {
    assert.equal(stacksAddressNetwork(LEATHER_TESTNET_STX), "testnet");
    assert.equal(stacksAddressNetwork(XVERSE_TESTNET_STX), "testnet");
    assert.equal(stacksAddressNetwork(MAINNET_STX), "mainnet");
    assert.equal(stacksAddressNetwork("STW7FVTAF3MD8C5WG2VH45SWWS34KBJNR8D04ZD"), "testnet");
    assert.equal(stacksAddressNetwork("SPJ8TAFSGD7FYAHQ3WQ7BTN8A4BVAGQEH8VM39B"), "mainnet");
  });

  it("rejects malformed addresses", () => {
    assert.equal(stacksAddressNetwork(""), null);
    assert.equal(stacksAddressNetwork(LEATHER_TESTNET_STX.toLowerCase()), null);
    assert.equal(stacksAddressNetwork("SX20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0"), null);
    assert.equal(stacksAddressNetwork("ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPKO"), null);
  });
});

describe("bitcoinAddressKind", () => {
  it("separates mainnet, public test networks and regtest", () => {
    assert.equal(bitcoinAddressKind("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), "mainnet");
    assert.equal(bitcoinAddressKind("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"), "mainnet");
    assert.equal(bitcoinAddressKind("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), "test");
    assert.equal(bitcoinAddressKind("bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw"), "regtest");
  });

  it("returns null for unknown formats", () => {
    assert.equal(bitcoinAddressKind("not-an-address"), null);
  });
});

describe("networkGuard", () => {
  it("passes a testnet Stacks address with a regtest Bitcoin address", () => {
    assert.equal(
      networkGuard("testnet", { stx: XVERSE_TESTNET_STX, btc: ["bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw"] }),
      null,
    );
  });

  it("flags a public test network Bitcoin address on Stacks testnet", () => {
    assert.equal(
      networkGuard("testnet", { stx: LEATHER_TESTNET_STX, btc: ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"] }),
      "NETWORK_MISMATCH",
    );
  });

  it("flags a Stacks address from the wrong network", () => {
    assert.equal(networkGuard("mainnet", { stx: LEATHER_TESTNET_STX }), "NETWORK_MISMATCH");
  });
});

describe("classifyWalletError", () => {
  it("treats rejection and cancel codes as USER_REJECTED for both wallets", () => {
    assert.equal(classifyWalletError("leather", { code: -32000, message: "rejected" }), "USER_REJECTED");
    assert.equal(classifyWalletError("xverse", { code: -31001, message: "canceled" }), "USER_REJECTED");
  });

  it("treats Leather's observed 4001 rejection as USER_REJECTED", () => {
    assert.equal(classifyWalletError("leather", { code: 4001, message: "User denied signing" }), "USER_REJECTED");
  });

  it("reads codes nested in a sats-connect style error response", () => {
    assert.equal(classifyWalletError("xverse", { status: "error", error: { code: -32000 } }), "USER_REJECTED");
  });

  it("maps -32001 differently per wallet", () => {
    assert.equal(classifyWalletError("xverse", { code: -32001 }), "UNSUPPORTED_WALLET");
    assert.equal(classifyWalletError("leather", { code: -32001 }), "UNCLASSIFIED");
  });

  it("leaves errors without a known code unclassified", () => {
    assert.equal(classifyWalletError("leather", new Error("boom")), "UNCLASSIFIED");
    assert.equal(classifyWalletError("xverse", null), "UNCLASSIFIED");
  });
});

describe("walletOutcome", () => {
  it("separates broadcast, signed and unknown results", () => {
    assert.equal(walletOutcome({ txid: "0xabc" }), "BROADCAST");
    assert.equal(walletOutcome({ transaction: "0080" }), "SIGNED");
    assert.equal(walletOutcome({ psbt: "70736274ff" }), "SIGNED");
  });

  it("never treats an empty or missing result as success", () => {
    assert.equal(walletOutcome({ txid: "" }), "UNKNOWN");
    assert.equal(walletOutcome({}), "UNKNOWN");
    assert.equal(walletOutcome(undefined), "UNKNOWN");
  });
});
