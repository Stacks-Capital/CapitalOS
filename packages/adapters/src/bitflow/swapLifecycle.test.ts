import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SwapSnapshot } from "../reads.ts";
import {
  assertBitflowRoute,
  evaluateBitflowSwap,
  previewBitflowMinOut,
  type BitflowSwapIntent,
} from "./swapLifecycle.ts";

const OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const ROUTER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2";
const POOL = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.sbtc-usdcx-dlmm-fixture";

const swap: SwapSnapshot = {
  poolId: POOL,
  routerId: ROUTER,
  amountIn: "100000000",
  amountOut: "99500000000",
  xAsset: "sbtc",
  stale: false,
  observedAt: "2026-09-15T11:59:30.000Z",
  source: "fixture",
  maxAgeMs: 180_000,
};

const intent: BitflowSwapIntent = {
  network: "mainnet",
  owner: OWNER,
  amount: "100000000",
  minOut: previewBitflowMinOut("99500000000"),
  poolId: POOL,
  routerId: ROUTER,
  inputAsset: "sbtc",
  idempotencyKey: "swap-1",
  quotedAt: "2026-09-15T11:59:30.000Z",
  expiresAt: "2026-09-15T12:01:30.000Z",
};

describe("K29 Bitflow swap lifecycle", () => {
  it("forces requote when the quote expires or the route changes", () => {
    assert.equal(assertBitflowRoute({ ...intent, expiresAt: "2026-09-15T11:59:00.000Z" }, swap, NOW).ok, false);
    assert.equal(assertBitflowRoute({ ...intent, poolId: "other.pool" }, swap, NOW).ok, false);
    assert.equal(assertBitflowRoute(intent, { ...swap, amountIn: "1" }, NOW).ok, false);
  });

  it("reconciles a canonical swap that meets min-out", () => {
    const lifecycle = evaluateBitflowSwap({
      intent,
      swap,
      settlement: {
        stacksTxid: "0x55",
        blockHeight: 3,
        blockHash: "0x66",
        canonical: true,
        amountIn: "100000000",
        amountOut: "99500000000",
        poolId: POOL,
        owner: OWNER,
      },
      broadcastKnown: true,
      now: NOW,
    });
    assert.equal(lifecycle.state, "reconciled");
    assert.equal(lifecycle.broadcastAllowed, false);
    assert.equal(lifecycle.complete, true);
  });

  it("fails closed when output is below min-out", () => {
    const lifecycle = evaluateBitflowSwap({
      intent,
      swap,
      settlement: {
        stacksTxid: "0x55",
        blockHeight: 3,
        blockHash: "0x66",
        canonical: true,
        amountIn: "100000000",
        amountOut: "1",
        poolId: POOL,
        owner: OWNER,
      },
      broadcastKnown: true,
      now: NOW,
    });
    assert.equal(lifecycle.state, "reconciliation_failed");
    assert.match(lifecycle.warnings.join(" "), /below min-out/);
  });

  it("keeps testnet unavailable and refuses non-fixture live pools until pinned", () => {
    assert.equal(
      evaluateBitflowSwap({
        intent: { ...intent, network: "testnet" },
        swap,
        settlement: null,
        broadcastKnown: false,
        now: NOW,
      }).state,
      "unavailable",
    );
    assert.equal(
      evaluateBitflowSwap({
        intent,
        swap: { ...swap, source: "live-ticker" },
        settlement: null,
        broadcastKnown: false,
        now: NOW,
      }).state,
      "unavailable",
    );
  });

  it("rejects abusive slippage above the product max", () => {
    assert.throws(
      () => previewBitflowMinOut("99500000000", 9999n),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "PLAN_INVALID" &&
        "message" in error &&
        typeof error.message === "string" &&
        /slippage must be between/.test(error.message),
    );
    assert.throws(
      () => previewBitflowMinOut("99500000000", -1n),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "PLAN_INVALID",
    );
  });
});
