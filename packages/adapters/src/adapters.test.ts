import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REGISTRY_VERSION } from "@stacks-capital/config";
import { validatePlan } from "@stacks-capital/core";
import {
  createBitflowSwapAdapter,
  createGraniteCreditAdapter,
  createSbtcDepositAdapter,
  createSbtcWithdrawAdapter,
  createZestEarnAdapter,
} from "./index.ts";
import type { AdapterContext, AdapterReads } from "./index.ts";

const reads: AdapterReads = {
  emilyLimits: { perDepositMinimum: "1000", perWithdrawalCap: "50100000000" },
  vault: {
    pausedDeposit: false,
    pausedRedeem: false,
    totalAssets: "66022279734",
    capSupply: "500000000000",
    shareRateNumerator: "1",
    shareRateDenominator: "1",
  },
  debtVault: {
    pausedDeposit: false,
    pausedRedeem: false,
    totalAssets: "250000000000",
    capSupply: "500000000000",
    shareRateNumerator: "1",
    shareRateDenominator: "1",
  },
  oracle: {
    sbtc: {
      price: "10000000000000",
      scale: "8",
      observedAt: "2026-09-15T12:00:00.000Z",
      source: "fixture",
      stale: false,
      maxAgeMs: 180_000,
    },
    usdcx: {
      price: "100000000",
      scale: "8",
      observedAt: "2026-09-15T12:00:00.000Z",
      source: "fixture",
      stale: false,
      maxAgeMs: 180_000,
    },
  },
  swap: {
    poolId: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.sbtc-usdcx-dlmm-fixture",
    routerId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2",
    amountIn: "100000000",
    amountOut: "99500000000",
    xAsset: "sbtc",
    stale: false,
    observedAt: "2026-09-15T12:00:00.000Z",
    source: "fixture",
    maxAgeMs: 180_000,
  },
  position: { collateral: "100000000", debt: "0" },
  riskParams: { ltvBorrowBps: "7000", ltvLiqBps: "8000", bufferBps: "500", sbtcDecimals: "8", usdcxDecimals: "6" },
};

const MAINNET_OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
const TESTNET_OWNER = "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0";

function ctx(network: "mainnet" | "testnet"): AdapterContext {
  return {
    network,
    now: new Date("2026-09-15T12:00:00.000Z"),
    owner: network === "mainnet" ? MAINNET_OWNER : TESTNET_OWNER,
    registryVersion: REGISTRY_VERSION,
  };
}

describe("sBTC and Zest adapters", () => {
  it("quotes a mainnet deposit and requires a Bitcoin payload, not a Stacks call", () => {
    const mainnet = ctx("mainnet");
    const deposit = createSbtcDepositAdapter(reads);
    const quote = deposit.quote(mainnet, {
      action: "deposit_sbtc",
      marketId: "sbtc.deposit",
      amount: "10000",
      recipient: MAINNET_OWNER,
      maxFee: "200",
    });
    assert.equal(quote.executable, true);
    assert.equal(quote.expectedOutput[0]?.quantity, 9800n);
    const plan = deposit.buildPlan(mainnet, quote, {
      action: "deposit_sbtc",
      marketId: "sbtc.deposit",
      amount: "10000",
      recipient: MAINNET_OWNER,
      maxFee: "200",
    });
    assert.equal(plan.steps[0]?.payload.kind, "bitcoin_deposit");
    assert.equal(
      validatePlan(plan, quote, {
        now: mainnet.now,
        network: "mainnet",
        registryVersion: mainnet.registryVersion,
        sender: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
      }).ok,
      true,
    );
  });

  it("refuses a testnet deposit plan because the capability is disabled", () => {
    const testnet = ctx("testnet");
    const deposit = createSbtcDepositAdapter(reads);
    const quote = deposit.quote(testnet, {
      action: "deposit_sbtc",
      marketId: "sbtc.deposit",
      amount: "10000",
      recipient: TESTNET_OWNER,
    });
    assert.equal(quote.executable, false);
    assert.throws(() =>
      deposit.buildPlan(testnet, quote, {
        action: "deposit_sbtc",
        marketId: "sbtc.deposit",
        amount: "10000",
        recipient: TESTNET_OWNER,
      }),
    );
  });

  it("builds a deny-mode initiate-withdrawal-request plan and will not call it complete", () => {
    const mainnet = ctx("mainnet");
    const withdraw = createSbtcWithdrawAdapter(reads);
    const recipient = "04:00112233445566778899aabbccddeeff00112233";
    const quote = withdraw.quote(mainnet, {
      action: "withdraw_sbtc",
      marketId: "sbtc.withdraw",
      amount: "10000",
      recipient,
      maxFee: "1000",
    });
    const plan = withdraw.buildPlan(mainnet, quote, {
      action: "withdraw_sbtc",
      marketId: "sbtc.withdraw",
      amount: "10000",
      recipient,
      maxFee: "1000",
    });
    const payload = plan.steps[0]?.payload;
    assert.equal(payload?.kind, "stacks_contract_call");
    if (payload?.kind === "stacks_contract_call") {
      assert.equal(payload.functionName, "initiate-withdrawal-request");
      assert.equal(payload.postConditionMode, "deny");
    }
    assert.match(quote.warnings.join(" "), /Bitcoin payout/);
  });

  it("supplies and redeems sBTC through the Zest vault with min-out rounding down", () => {
    const mainnet = ctx("mainnet");
    const zest = createZestEarnAdapter(reads);
    const supply = zest.quote(mainnet, { action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });
    const supplyPlan = zest.buildPlan(mainnet, supply, {
      action: "supply",
      marketId: "zest.sbtc.vault",
      amount: "100000000",
    });
    assert.equal(supply.expectedOutput[0]?.quantity, 100000000n);
    const call = supplyPlan.steps[0]?.payload;
    assert.ok(call?.kind === "stacks_contract_call" && call.functionName === "deposit");
    const redeem = zest.quote(mainnet, {
      action: "withdraw_supply",
      marketId: "zest.sbtc.vault",
      amount: "100000000",
      minOut: "100000000",
    });
    zest.buildPlan(mainnet, redeem, {
      action: "withdraw_supply",
      marketId: "zest.sbtc.vault",
      amount: "100000000",
      minOut: "100000000",
    });
    assert.equal(zest.explainRisk(mainnet, "zest.sbtc.vault").variables.rounding, "down");
  });

  it("quotes Granite isolated collateral and USDCx borrow with deny-mode price-feeds none", () => {
    const mainnet = ctx("mainnet");
    const granite = createGraniteCreditAdapter(reads);
    const borrow = granite.quote(mainnet, {
      action: "borrow",
      marketId: "granite.sbtc.isolated",
      amount: "50000000000",
    });
    const plan = granite.buildPlan(mainnet, borrow, {
      action: "borrow",
      marketId: "granite.sbtc.isolated",
      amount: "50000000000",
    });
    const call = plan.steps[0]?.payload;
    assert.ok(call?.kind === "stacks_contract_call" && call.functionName === "borrow");
    assert.equal(call.functionArgs[3]?.type, "none");
    assert.equal(call.postConditions[0]?.mode, "receive_gte");
  });

  it("plans a Bitflow sBTC to USDCx swap with onchain min-out", () => {
    const mainnet = ctx("mainnet");
    const bitflow = createBitflowSwapAdapter(reads);
    const intent = { action: "swap" as const, marketId: "bitflow.sbtc-usdcx", amount: "100000000" };
    const quote = bitflow.quote(mainnet, intent);
    const plan = bitflow.buildPlan(mainnet, quote, intent);
    const call = plan.steps[0]?.payload;
    assert.ok(call?.kind === "stacks_contract_call" && call.functionName === "swap-x-for-y-simple-range-multi");
    assert.equal(quote.minimumOutput?.quantity, 99002500000n);
  });
});
