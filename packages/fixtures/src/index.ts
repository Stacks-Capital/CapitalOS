import { REGISTRY_VERSION } from "@stacks-capital/config";
import {
  createBitflowSwapAdapter,
  createGraniteCreditAdapter,
  createSbtcDepositAdapter,
  createSbtcWithdrawAdapter,
  createZestEarnAdapter,
  type AdapterContext,
  type AdapterReads,
} from "@stacks-capital/adapters";
import { ORACLE_MAX_AGE_MS, type StacksNetwork } from "@stacks-capital/core";

export const MAINNET_OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
export const TESTNET_OWNER = "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0";
export const FIXTURE_NOW = "2026-09-15T12:00:00.000Z";
export const FIXTURE_BITFLOW_POOL = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.sbtc-usdcx-dlmm-fixture";

const oracle = {
  price: { sbtc: "10000000000000", usdcx: "100000000" },
  scale: "8",
  observedAt: FIXTURE_NOW,
  source: "fixture",
  stale: false,
  maxAgeMs: ORACLE_MAX_AGE_MS,
};

export const MAINNET_READS: AdapterReads = {
  emilyLimits: {
    perDepositMinimum: "1000",
    perWithdrawalCap: "50100000000",
    pegCap: "2100000000000000",
  },
  vault: {
    pausedDeposit: false,
    pausedRedeem: false,
    totalAssets: "66022279734",
    capSupply: "500000000000",
    // Deployable capacity is evidence a ranking depends on, so the fixture carries it the way a
    // live read does. Drop it and compareEarn correctly refuses to rank this market.
    availableAssets: "433977720266",
    shareRateNumerator: "1",
    shareRateDenominator: "1",
  },
  debtVault: {
    pausedDeposit: false,
    pausedRedeem: false,
    totalAssets: "250000000000",
    capSupply: "500000000000",
    availableAssets: "250000000000",
    shareRateNumerator: "1",
    shareRateDenominator: "1",
  },
  oracle: {
    sbtc: {
      price: oracle.price.sbtc,
      scale: oracle.scale,
      observedAt: oracle.observedAt,
      source: oracle.source,
      stale: oracle.stale,
      maxAgeMs: oracle.maxAgeMs,
    },
    usdcx: {
      price: oracle.price.usdcx,
      scale: oracle.scale,
      observedAt: oracle.observedAt,
      source: oracle.source,
      stale: oracle.stale,
      maxAgeMs: oracle.maxAgeMs,
    },
  },
  swap: {
    poolId: FIXTURE_BITFLOW_POOL,
    routerId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2",
    amountIn: "100000000",
    amountOut: "99500000000",
    xAsset: "sbtc",
    stale: false,
    observedAt: FIXTURE_NOW,
    source: "fixture",
    maxAgeMs: ORACLE_MAX_AGE_MS,
  },
  position: {
    collateral: "100000000",
    debt: "0",
  },
  riskParams: {
    ltvBorrowBps: "7000",
    ltvLiqBps: "8000",
    bufferBps: "500",
    sbtcDecimals: "8",
    usdcxDecimals: "6",
  },
};

export const TESTNET_READS: AdapterReads = {
  emilyLimits: {
    perDepositMinimum: "1000",
    perWithdrawalCap: "50100000000",
  },
};

export function adapterContext(network: StacksNetwork, now = new Date(FIXTURE_NOW)): AdapterContext {
  return {
    network,
    now,
    owner: network === "mainnet" ? MAINNET_OWNER : TESTNET_OWNER,
    registryVersion: REGISTRY_VERSION,
  };
}

export function sandboxAdapters(network: StacksNetwork, reads = network === "mainnet" ? MAINNET_READS : TESTNET_READS) {
  return {
    deposit: createSbtcDepositAdapter(reads),
    withdraw: createSbtcWithdrawAdapter(reads),
    zest: createZestEarnAdapter(reads),
    granite: createGraniteCreditAdapter(reads),
    bitflow: createBitflowSwapAdapter(reads),
    reads,
  };
}

export {
  FIXTURE_GOLDEN_ADDRESSES,
  GOLDEN_FIXTURE_OWNER,
  GOLDEN_FIXTURE_POSITION,
  reconcileFixtureGoldenAddresses,
  reconcileGoldenPositions,
  reconcileGoldenPortfolioAccounting,
} from "./goldenAddresses.ts";
export type {
  GoldenAddress,
  GoldenPositionExpectation,
  GoldenReconcileResult,
  GoldenPortfolioAccountingReport,
} from "./goldenAddresses.ts";
