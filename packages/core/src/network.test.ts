import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BITCOIN_FOR_STACKS, bitcoinAddressKind, stacksAddressNetwork } from "./network.ts";

describe("address network guards", () => {
  it("maps Stacks prefixes and Bitcoin address kinds used by I02", () => {
    assert.equal(stacksAddressNetwork("SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR"), "mainnet");
    assert.equal(stacksAddressNetwork("ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0"), "testnet");
    assert.equal(bitcoinAddressKind("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), "mainnet");
    assert.equal(bitcoinAddressKind("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), "test");
    assert.equal(bitcoinAddressKind("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"), "regtest");
    assert.equal(BITCOIN_FOR_STACKS.testnet, "regtest");
  });

  it("accepts Stacks addresses that c32check shortened by dropping leading zeros", () => {
    assert.equal(stacksAddressNetwork("SPJ8TAFSGD7FYAHQ3WQ7BTN8A4BVAGQEH8VM39B"), "mainnet");
    assert.equal(stacksAddressNetwork("STW7FVTAF3MD8C5WG2VH45SWWS34KBJNR8D04ZD"), "testnet");
  });
});
