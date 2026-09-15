import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPABILITIES, CONTRACTS, assertExecutable, capabilityFor, contract } from "./deployments.ts";

describe("capability registry", () => {
  it("pins the I01 sBTC and USDCx principals", () => {
    assert.equal(contract("sbtc", "sbtc-token", "mainnet").contractId, "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token");
    assert.equal(contract("sbtc", "sbtc-token", "testnet").contractId, "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token");
    assert.equal(contract("usdcx", "usdcx", "mainnet").contractId, "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx");
  });

  it("enables mainnet sBTC deposit and Zest supply, and disables testnet deposit and staking", () => {
    assert.equal(assertExecutable("deposit_sbtc", "mainnet").state, "enabled");
    assert.equal(assertExecutable("supply", "mainnet", "zest").state, "enabled");
    assert.equal(assertExecutable("borrow", "mainnet", "granite").state, "enabled");
    assert.equal(assertExecutable("swap", "mainnet", "bitflow").state, "enabled");
    assert.equal(capabilityFor("deposit_sbtc", "testnet")?.state, "disabled");
    assert.equal(capabilityFor("stake", "mainnet")?.state, "disabled");
    assert.equal(capabilityFor("borrow", "testnet", "granite")?.state, "disabled");
    assert.equal(capabilityFor("swap", "testnet", "bitflow")?.state, "disabled");
    assert.ok(CAPABILITIES.length > 0);
    assert.ok(CONTRACTS.some((item) => item.label === "v0-4-market" && item.role === "superseded_market"));
    assert.ok(CONTRACTS.some((item) => item.label === "dlmm-swap-router-v-1-1" && item.role === "superseded_router"));
    assert.equal(contract("zest", "v0-vault-usdc", "mainnet").revision, "6162068");
    assert.equal(contract("bitflow", "dlmm-swap-router-v-1-2", "mainnet").revision, "6979616");
  });

  it("does not treat the npm testnet sBTC principal as canonical", () => {
    assert.equal(
      CONTRACTS.some((item) => item.contractId.startsWith("SNGWPN3XDAQE673MXYXF81016M50NHF5X5PWWM70")),
      false,
    );
  });
});
