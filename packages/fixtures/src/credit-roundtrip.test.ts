import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityFor, executableContractIds } from "@stacks-capital/config";
import { assertValidPlan, marketsComparable } from "@stacks-capital/core";
import { adapterContext, FIXTURE_BITFLOW_POOL, MAINNET_OWNER, MAINNET_READS, sandboxAdapters } from "./index.ts";
import type { AdapterReads } from "@stacks-capital/adapters";

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

function withReads(patch: (base: AdapterReads) => AdapterReads): AdapterReads {
  return patch(MAINNET_READS);
}

describe("K11-K14 credit, swap and risk", () => {
  it("adds isolated Granite collateral, borrows USDCx, then repays without treating it as Zest earn", () => {
    const ctx = adapterContext("mainnet");
    const { granite, zest } = sandboxAdapters("mainnet");
    assert.equal(
      marketsComparable({ protocol: "zest", action: "supply" }, { protocol: "granite", action: "supply" }),
      false,
    );
    assert.match(zest.explainRisk(ctx, "zest.sbtc.vault").disclosures.join(" "), /receipt claim/);
    assert.match(granite.explainRisk(ctx, "granite.sbtc.isolated").disclosures.join(" "), /locked sBTC/);

    const supply = granite.quote(ctx, { action: "supply", marketId: "granite.sbtc.isolated", amount: "100000000" });
    const supplyPlan = granite.buildPlan(ctx, supply, {
      action: "supply",
      marketId: "granite.sbtc.isolated",
      amount: "100000000",
    });
    assertValidPlan(supplyPlan, supply, {
      now: ctx.now,
      network: "mainnet",
      registryVersion: ctx.registryVersion,
      allowedContracts: executableContractIds("mainnet"),
      sender: MAINNET_OWNER,
    });
    const add = supplyPlan.steps[0]?.payload;
    assert.ok(add?.kind === "stacks_contract_call" && add.functionName === "collateral-add");
    assert.equal(add.postConditionMode, "deny");
    assert.equal(add.functionArgs[2]?.type, "none");

    const borrow = granite.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "50000000000" });
    const borrowPlan = granite.buildPlan(ctx, borrow, {
      action: "borrow",
      marketId: "granite.sbtc.isolated",
      amount: "50000000000",
    });
    assertValidPlan(borrowPlan, borrow, {
      now: ctx.now,
      network: "mainnet",
      registryVersion: ctx.registryVersion,
      allowedContracts: executableContractIds("mainnet"),
      sender: MAINNET_OWNER,
    });
    const borrowCall = borrowPlan.steps[0]?.payload;
    assert.ok(borrowCall?.kind === "stacks_contract_call" && borrowCall.functionName === "borrow");
    assert.equal(borrowCall.postConditions[0]?.mode, "receive_gte");

    const { granite: graniteWithDebt } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({ ...base, position: { collateral: "100000000", debt: "50000000000" } })),
    );
    const repay = graniteWithDebt.quote(ctx, {
      action: "repay",
      marketId: "granite.sbtc.isolated",
      amount: "50000000000",
    });
    const repayPlan = graniteWithDebt.buildPlan(ctx, repay, {
      action: "repay",
      marketId: "granite.sbtc.isolated",
      amount: "50000000000",
    });
    assertValidPlan(repayPlan, repay, {
      now: ctx.now,
      network: "mainnet",
      registryVersion: ctx.registryVersion,
      allowedContracts: executableContractIds("mainnet"),
      sender: MAINNET_OWNER,
    });
    const repayCall = repayPlan.steps[0]?.payload;
    assert.ok(repayCall?.kind === "stacks_contract_call" && repayCall.functionName === "repay");
  });

  it("opens a two-step loan when borrow includes a collateral amount", () => {
    const ctx = adapterContext("mainnet");
    const { granite } = sandboxAdapters("mainnet");
    const intent = {
      action: "borrow" as const,
      marketId: "granite.sbtc.isolated",
      amount: "40000000000",
      collateralAmount: "50000000",
    };
    const quote = granite.quote(ctx, intent);
    const plan = granite.buildPlan(ctx, quote, intent);
    assert.equal(plan.steps.map((step) => step.id).join(","), "collateral-add,borrow");
    assert.deepEqual(plan.steps[1]?.dependsOn, ["collateral-add"]);
    assertValidPlan(plan, quote, {
      now: ctx.now,
      network: "mainnet",
      registryVersion: ctx.registryVersion,
      allowedContracts: executableContractIds("mainnet"),
      sender: MAINNET_OWNER,
    });
  });

  it("fail-closes Granite quotes on a stale oracle and refuses an over-LTV borrow", () => {
    const ctx = adapterContext("mainnet");
    const oracle = MAINNET_READS.oracle;
    assert.ok(oracle);
    const { granite: stale } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({
        ...base,
        oracle: { sbtc: { ...oracle.sbtc, stale: true }, usdcx: oracle.usdcx },
      })),
    );
    assert.throws(
      () => stale.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }),
      (error: unknown) => codeOf(error) === "ORACLE_STALE",
    );

    const { granite } = sandboxAdapters("mainnet");
    assert.throws(
      () => granite.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "90000000000" }),
      (error: unknown) => codeOf(error) === "CAP_REACHED",
    );
  });

  it("plans a healthy Granite collateral remove and fail-closes unhealthy or stale withdraws", () => {
    const ctx = adapterContext("mainnet");
    const { granite } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({ ...base, position: { collateral: "100000000", debt: "10000000000" } })),
    );
    const intent = {
      action: "withdraw_supply" as const,
      marketId: "granite.sbtc.isolated",
      amount: "10000000",
    };
    const quote = granite.quote(ctx, intent);
    const plan = granite.buildPlan(ctx, quote, intent);
    assertValidPlan(plan, quote, {
      now: ctx.now,
      network: "mainnet",
      registryVersion: ctx.registryVersion,
      allowedContracts: executableContractIds("mainnet"),
      sender: MAINNET_OWNER,
    });
    const call = plan.steps[0]?.payload;
    assert.ok(call?.kind === "stacks_contract_call" && call.functionName === "collateral-remove");
    assert.equal(call.postConditionMode, "deny");
    assert.equal(call.postConditions[0]?.mode, "receive_gte");

    const { granite: stressed } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({ ...base, position: { collateral: "100000000", debt: "69000000000" } })),
    );
    assert.throws(
      () =>
        stressed.quote(ctx, {
          action: "withdraw_supply",
          marketId: "granite.sbtc.isolated",
          amount: "50000000",
        }),
      (error: unknown) => codeOf(error) === "CAP_REACHED",
    );

    const oracle = MAINNET_READS.oracle;
    assert.ok(oracle);
    const { granite: stale } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({
        ...base,
        position: { collateral: "100000000", debt: "10000000000" },
        oracle: { sbtc: { ...oracle.sbtc, stale: true }, usdcx: oracle.usdcx },
      })),
    );
    assert.throws(
      () =>
        stale.quote(ctx, {
          action: "withdraw_supply",
          marketId: "granite.sbtc.isolated",
          amount: "10000000",
        }),
      (error: unknown) => codeOf(error) === "ORACLE_STALE",
    );
  });

  it("rejects Bitflow quotes that request abusive slippage or a zero min-out floor breach", () => {
    const ctx = adapterContext("mainnet");
    const { bitflow } = sandboxAdapters("mainnet");
    assert.throws(
      () =>
        bitflow.quote(ctx, {
          action: "swap",
          marketId: "bitflow.sbtc-usdcx",
          amount: "100000000",
          routePool: FIXTURE_BITFLOW_POOL,
          slippageBps: "9999",
        }),
      (error: unknown) => codeOf(error) === "PLAN_INVALID",
    );
    assert.throws(
      () =>
        bitflow.quote(ctx, {
          action: "swap",
          marketId: "bitflow.sbtc-usdcx",
          amount: "100000000",
          routePool: FIXTURE_BITFLOW_POOL,
          minOut: "1",
        }),
      (error: unknown) => codeOf(error) === "PLAN_INVALID",
    );
  });

  it("plans an allowlisted Bitflow sBTC to USDCx swap with onchain min-out", () => {
    const ctx = adapterContext("mainnet");
    const { bitflow } = sandboxAdapters("mainnet");
    const intent = {
      action: "swap" as const,
      marketId: "bitflow.sbtc-usdcx",
      amount: "100000000",
      routePool: FIXTURE_BITFLOW_POOL,
    };
    const quote = bitflow.quote(ctx, intent);
    assert.equal(quote.minimumOutput?.quantity, 99002500000n);
    const plan = bitflow.buildPlan(ctx, quote, intent);
    assertValidPlan(plan, quote, {
      now: ctx.now,
      network: "mainnet",
      registryVersion: ctx.registryVersion,
      allowedContracts: executableContractIds("mainnet"),
      sender: MAINNET_OWNER,
    });
    const call = plan.steps[0]?.payload;
    assert.ok(call?.kind === "stacks_contract_call");
    assert.equal(call.functionName, "swap-x-for-y-simple-range-multi");
    assert.equal(call.contractId, "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2");
    const minOutArg = call.functionArgs[4];
    assert.equal(minOutArg?.type === "uint" ? minOutArg.value : "", "99002500000");
    assert.equal(call.functionArgs[6]?.type, "none");
    assert.equal(call.postConditions.map((item) => item.mode).join(","), "send_lte,receive_gte");
  });

  it("fail-closes a stale Bitflow route and keeps testnet granite/swap disabled", () => {
    const ctx = adapterContext("mainnet");
    const swap = MAINNET_READS.swap;
    assert.ok(swap);
    const { bitflow } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({ ...base, swap: { ...swap, stale: true } })),
    );
    assert.throws(
      () => bitflow.quote(ctx, { action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" }),
      (error: unknown) => codeOf(error) === "ORACLE_STALE",
    );
    assert.equal(capabilityFor("borrow", "testnet", "granite")?.state, "disabled");
    assert.equal(capabilityFor("swap", "testnet", "bitflow")?.state, "disabled");
  });

  it("refuses repay above current debt, a paused vault, and an unknown position", () => {
    const ctx = adapterContext("mainnet");
    const { granite } = sandboxAdapters("mainnet");
    assert.throws(
      () => granite.quote(ctx, { action: "repay", marketId: "granite.sbtc.isolated", amount: "1" }),
      (error: unknown) => codeOf(error) === "INSUFFICIENT_BALANCE",
    );

    const vault = MAINNET_READS.debtVault;
    assert.ok(vault);
    const { granite: paused } = sandboxAdapters(
      "mainnet",
      withReads((base) => ({
        ...base,
        debtVault: { ...vault, pausedRedeem: true },
      })),
    );
    assert.throws(
      () => paused.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }),
      (error: unknown) => codeOf(error) === "CAPABILITY_DISABLED",
    );

    const { granite: unknownPosition } = sandboxAdapters(
      "mainnet",
      withReads((base) => {
        const { position: _dropped, ...rest } = base;
        return rest;
      }),
    );
    assert.throws(
      () => unknownPosition.quote(ctx, { action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }),
      (error: unknown) => codeOf(error) === "PLAN_INVALID",
    );
  });
});
