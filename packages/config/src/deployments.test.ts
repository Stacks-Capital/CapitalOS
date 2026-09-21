import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSETS,
  CAPABILITIES,
  CONTRACTS,
  FUNGIBLE_ASSET_NAME,
  assertExecutable,
  capabilityFor,
  contract,
  executableContractIds,
  findContract,
} from "./deployments.ts";

describe("capability registry", () => {
  it("pins the I01 sBTC and USDCx principals", () => {
    assert.equal(
      contract("sbtc", "sbtc-token", "mainnet").contractId,
      "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    );
    assert.equal(
      contract("sbtc", "sbtc-token", "testnet").contractId,
      "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    );
    assert.equal(contract("usdcx", "usdcx", "mainnet").contractId, "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx");
    assert.equal(contract("granite", "v0-8-market", "mainnet").protocol, "granite");
    assert.equal(
      contract("dia", "dia-oracle", "mainnet").contractId,
      "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle",
    );
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
    assert.equal(FUNGIBLE_ASSET_NAME.usdcx, "usdcx-token");
    assert.equal(FUNGIBLE_ASSET_NAME.zestShares, "zft");
  });

  it("does not invent a Zest vault on public testnet", () => {
    assert.equal(findContract("zest", "v0-vault-sbtc", "testnet"), undefined);
    assert.throws(() => contract("zest", "v0-vault-sbtc", "testnet"), /No contract zest\/v0-vault-sbtc on testnet/);
  });

  it("does not treat the npm testnet sBTC principal as canonical", () => {
    assert.equal(
      CONTRACTS.some((item) => item.contractId.startsWith("SNGWPN3XDAQE673MXYXF81016M50NHF5X5PWWM70")),
      false,
    );
  });

  it("keeps reads and exits available while safe-exit-only mode pauses new risk", () => {
    assert.ok(ASSETS.some((asset) => asset.protocol === "sbtc" && asset.network === "mainnet"));
    assert.equal(capabilityFor("supply", "mainnet", "zest", "safe_exit_only")?.state, "paused");
    assert.equal(capabilityFor("borrow", "mainnet", "granite", "safe_exit_only")?.state, "paused");
    assert.equal(capabilityFor("withdraw_supply", "mainnet", "zest", "safe_exit_only")?.state, "enabled");
    assert.equal(capabilityFor("repay", "mainnet", "granite", "safe_exit_only")?.state, "enabled");
    assert.equal(contract("zest", "v0-vault-sbtc", "mainnet").role, "earn_vault");
  });

  it("derives signing targets only from reviewed non-disabled capabilities", () => {
    const mainnet = executableContractIds("mainnet");
    assert.ok(mainnet.includes("SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc"));
    assert.equal(mainnet.includes("SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market"), false);
    assert.equal(
      mainnet.some((contractId) => contractId.startsWith("ST") || contractId.startsWith("SN")),
      false,
    );
  });
});
