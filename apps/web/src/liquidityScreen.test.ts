import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_POOL_PRINCIPALS,
  buildPoolView,
  calculateImpermanentLoss,
  calculateLpAccounting,
  IL_SCENARIOS,
  ilScenarios,
  isLpActionExecutable,
  SBTC_DEF,
  USDCX_DEF,
} from "./liquidityState.ts";

describe("Liquidity Provision and LP Screens (I37)", () => {
  // -----------------------------------------------------------------------
  // Range/bin disclosure
  // -----------------------------------------------------------------------
  describe("pool view and range disclosure", () => {
    it("builds a pool view with unavailable state when no pools are allowlisted", () => {
      const view = buildPoolView(null, "mainnet");
      assert.equal(view.executable, false);
      assert.equal(view.capabilityState, "unavailable");
      assert.match(view.capabilityReason, /Pilot Blocker B6/);
      assert.equal(view.activeBinId, null);
      assert.equal(view.rangeLower, null);
      assert.equal(view.rangeUpper, null);
      assert.equal(view.inRange, false);
    });

    it("provides canonical token pair definitions", () => {
      const view = buildPoolView(null, "mainnet");
      assert.equal(view.pair.x.symbol, "sBTC");
      assert.equal(view.pair.x.decimals, 8);
      assert.equal(view.pair.y.symbol, "USDCx");
      assert.equal(view.pair.y.decimals, 6);
      assert.equal(view.protocol, "bitflow");
      assert.equal(view.feeTierBps, 30);
    });

    it("returns exit liquidity data unavailable when pool is not allowlisted", () => {
      const view = buildPoolView(null, "mainnet");
      assert.equal(view.exitLiquidity.reserveX, "0");
      assert.equal(view.exitLiquidity.reserveY, "0");
      assert.equal(view.exitLiquidity.lockType, "instant");
      assert.match(view.exitLiquidity.depthDescription, /not yet allowlisted/);
    });

    it("has empty ALLOWED_POOL_PRINCIPALS (Pilot Blocker B6)", () => {
      assert.equal(ALLOWED_POOL_PRINCIPALS.length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Impermanent loss estimation
  // -----------------------------------------------------------------------
  describe("impermanent loss calculation", () => {
    it("computes IL correctly for symmetric price increases", () => {
      // +100% price change: k=2, IL = 2√2/(1+2) - 1 ≈ -5.72%
      const result = calculateImpermanentLoss(100);
      assert.equal(result.k, 2);
      assert.ok(result.ilPercent < 0, "IL should be negative (a loss)");
      // Expected: -5.72% (rounded to two decimal places)
      assert.ok(result.ilPercent >= -6 && result.ilPercent <= -5);
    });

    it("computes IL correctly for price decreases", () => {
      // -50% price change: k=0.5, IL = 2√0.5/(1+0.5) - 1 ≈ -5.72%
      const result = calculateImpermanentLoss(-50);
      assert.equal(result.k, 0.5);
      assert.ok(result.ilPercent < 0);
      assert.ok(result.ilPercent >= -6 && result.ilPercent <= -5);
    });

    it("returns zero IL when price does not change", () => {
      const result = calculateImpermanentLoss(0);
      assert.equal(result.k, 1);
      assert.equal(result.ilPercent, 0);
    });

    it("handles extreme negative price change gracefully", () => {
      const result = calculateImpermanentLoss(-100);
      assert.equal(result.k, 0);
      assert.equal(result.ilPercent, -100);
    });

    it("discloses formula and limitations", () => {
      const result = calculateImpermanentLoss(25);
      assert.match(result.formulaDisclosure, /2√k/);
      assert.ok(result.limitations.length >= 3);
      assert.ok(result.limitations.some((l) => l.includes("DLMM")));
      assert.ok(result.limitations.some((l) => l.includes("fees")));
    });

    it("generates all preset IL scenarios", () => {
      const scenarios = ilScenarios();
      assert.equal(scenarios.length, IL_SCENARIOS.length);
      for (const s of scenarios) {
        assert.ok(typeof s.ilPercent === "number");
        assert.ok(s.formulaDisclosure.length > 0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // LP accounting with integer base-unit precision
  // -----------------------------------------------------------------------
  describe("LP position accounting", () => {
    it("computes pool share and pooled assets correctly", () => {
      const result = calculateLpAccounting({
        totalLpTokens: 10000n,
        userLpTokens: 2500n,
        reserveX: 100000000n, // 1.0 sBTC
        reserveY: 6500000000n, // 6500 USDCx
        unclaimedFeesX: 50000n,
        unclaimedFeesY: 325000n,
      });

      assert.equal(result.poolShareBps, 2500n); // 25%
      assert.equal(result.pooledX, 25000000n); // 0.25 sBTC
      assert.equal(result.pooledY, 1625000000n); // 1625 USDCx
      assert.equal(result.unclaimedFeesX, 50000n);
      assert.equal(result.unclaimedFeesY, 325000n);
    });

    it("returns zero for empty pool", () => {
      const result = calculateLpAccounting({
        totalLpTokens: 0n,
        userLpTokens: 0n,
        reserveX: 0n,
        reserveY: 0n,
        unclaimedFeesX: 0n,
        unclaimedFeesY: 0n,
      });

      assert.equal(result.poolShareBps, 0n);
      assert.equal(result.pooledX, 0n);
      assert.equal(result.pooledY, 0n);
    });

    it("handles 100% pool ownership", () => {
      const result = calculateLpAccounting({
        totalLpTokens: 5000n,
        userLpTokens: 5000n,
        reserveX: 200000000n,
        reserveY: 13000000000n,
        unclaimedFeesX: 0n,
        unclaimedFeesY: 0n,
      });

      assert.equal(result.poolShareBps, 10000n); // 100%
      assert.equal(result.pooledX, 200000000n);
      assert.equal(result.pooledY, 13000000000n);
    });
  });

  // -----------------------------------------------------------------------
  // Capability gating
  // -----------------------------------------------------------------------
  describe("LP action capability gating", () => {
    it("returns executable: false for unpinned pool principals", () => {
      const result = isLpActionExecutable("add_liquidity", "mainnet", null);
      assert.equal(result.executable, false);
      assert.match(result.reason, /Pilot Blocker B6/);
    });

    it("returns executable: false for unknown pool principals", () => {
      const result = isLpActionExecutable("add_liquidity", "mainnet", "SP999.unknown-pool");
      assert.equal(result.executable, false);
      assert.match(result.reason, /Pilot Blocker B6/);
    });

    it("returns executable: false on testnet", () => {
      const result = isLpActionExecutable("add_liquidity", "testnet", null);
      assert.equal(result.executable, false);
      assert.match(result.reason, /testnet/i);
    });

    it("blocks remove_liquidity and claim_fees with the same guard", () => {
      for (const action of ["remove_liquidity", "claim_fees"] as const) {
        const result = isLpActionExecutable(action, "mainnet", null);
        assert.equal(result.executable, false);
      }
    });
  });
});
