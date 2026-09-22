import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getStakingRoutes,
  groupByCategory,
  isStakingSignable,
  type StakingCategory,
  type StakingRouteView,
} from "./stakingState.ts";

describe("Staking Screens (I37)", () => {
  // -----------------------------------------------------------------------
  // Category taxonomy
  // -----------------------------------------------------------------------
  describe("staking category taxonomy", () => {
    it("returns exactly three canonical routes per network", () => {
      for (const network of ["mainnet", "testnet"] as const) {
        const routes = getStakingRoutes(network);
        assert.equal(routes.length, 3);

        const categories = routes.map((r) => r.category);
        assert.ok(categories.includes("native_bitcoin"));
        assert.ok(categories.includes("stx_stacking"));
        assert.ok(categories.includes("protocol_receipt"));
      }
    });

    it("distinguishes Native Bitcoin from STX stacking and protocol receipts", () => {
      const routes = getStakingRoutes("mainnet");
      const native = routes.find((r) => r.category === "native_bitcoin")!;
      const stx = routes.find((r) => r.category === "stx_stacking")!;
      const receipt = routes.find((r) => r.category === "protocol_receipt")!;

      assert.notEqual(native.categoryLabel, stx.categoryLabel);
      assert.notEqual(native.categoryLabel, receipt.categoryLabel);
      assert.notEqual(stx.categoryLabel, receipt.categoryLabel);

      assert.notEqual(native.categoryBadge, stx.categoryBadge);
      assert.notEqual(native.categoryBadge, receipt.categoryBadge);
    });

    it("groups routes by category correctly", () => {
      const routes = getStakingRoutes("mainnet");
      const grouped = groupByCategory(routes);
      assert.equal(grouped.size, 3);
      assert.equal(grouped.get("native_bitcoin")?.length, 1);
      assert.equal(grouped.get("stx_stacking")?.length, 1);
      assert.equal(grouped.get("protocol_receipt")?.length, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Native Bitcoin staking — K33/K16/K02 invariant
  // -----------------------------------------------------------------------
  describe("native Bitcoin staking (PoX)", () => {
    it("returns executable: false and broadcastAllowed: false on both networks", () => {
      for (const network of ["mainnet", "testnet"] as const) {
        const routes = getStakingRoutes(network);
        const native = routes.find((r) => r.category === "native_bitcoin")!;
        assert.equal(native.executable, false);
        assert.equal(native.broadcastAllowed, false);
        assert.equal(native.capabilityState, "unavailable");
        assert.match(native.capabilityReason, /lockup signing|K02|K16/i);
      }
    });

    it("documents that native staking is NOT sBTC DeFi supply", () => {
      const routes = getStakingRoutes("mainnet");
      const native = routes.find((r) => r.category === "native_bitcoin")!;
      assert.ok(native.distinctions.some((d) => d.includes("not sBTC DeFi")));
    });

    it("documents that zsBTC earn receipts are not staking positions", () => {
      const routes = getStakingRoutes("mainnet");
      const native = routes.find((r) => r.category === "native_bitcoin")!;
      assert.ok(native.distinctions.some((d) => d.includes("zsBTC")));
    });

    it("documents that unstake stays gated", () => {
      const routes = getStakingRoutes("mainnet");
      const native = routes.find((r) => r.category === "native_bitcoin")!;
      assert.ok(native.distinctions.some((d) => d.includes("unstake")));
    });

    it("discloses lockup and custody assumptions", () => {
      const routes = getStakingRoutes("mainnet");
      const native = routes.find((r) => r.category === "native_bitcoin")!;
      assert.equal(native.custodyModel, "l1_bitcoin_consensus");
      assert.match(native.custodyDescription, /L1 chain/);
      assert.equal(native.lockupPeriodBlocks, 2100);
    });
  });

  // -----------------------------------------------------------------------
  // STX stacking (StackingDAO)
  // -----------------------------------------------------------------------
  describe("STX stacking (StackingDAO)", () => {
    it("returns executable: false for unverified integration", () => {
      const routes = getStakingRoutes("mainnet");
      const stx = routes.find((r) => r.category === "stx_stacking")!;
      assert.equal(stx.executable, false);
      assert.equal(stx.broadcastAllowed, false);
      assert.equal(stx.capabilityState, "unavailable");
    });

    it("distinguishes stSTX as a liquid stacking receipt", () => {
      const routes = getStakingRoutes("mainnet");
      const stx = routes.find((r) => r.category === "stx_stacking")!;
      assert.equal(stx.receiptAsset, "stSTX");
      assert.ok(stx.distinctions.some((d) => d.includes("liquid stacking receipt")));
    });

    it("discloses unbonding period", () => {
      const routes = getStakingRoutes("mainnet");
      const stx = routes.find((r) => r.category === "stx_stacking")!;
      assert.equal(stx.unbondingDays, 14);
    });

    it("labels yield provenance as provider-reported", () => {
      const routes = getStakingRoutes("mainnet");
      const stx = routes.find((r) => r.category === "stx_stacking")!;
      assert.equal(stx.rewardsProvenance.confidence, "provider_reported");
    });
  });

  // -----------------------------------------------------------------------
  // Protocol receipt staking (Hermetica)
  // -----------------------------------------------------------------------
  describe("protocol receipt staking (Hermetica)", () => {
    it("returns executable: false for unverified integration", () => {
      const routes = getStakingRoutes("mainnet");
      const receipt = routes.find((r) => r.category === "protocol_receipt")!;
      assert.equal(receipt.executable, false);
      assert.equal(receipt.broadcastAllowed, false);
    });

    it("distinguishes sUSDh as a yield vault receipt, not staking", () => {
      const routes = getStakingRoutes("mainnet");
      const receipt = routes.find((r) => r.category === "protocol_receipt")!;
      assert.equal(receipt.receiptAsset, "sUSDh");
      assert.ok(receipt.distinctions.some((d) => d.includes("yield vault receipt")));
    });

    it("labels provider-reported rates as non-verified", () => {
      const routes = getStakingRoutes("mainnet");
      const receipt = routes.find((r) => r.category === "protocol_receipt")!;
      assert.equal(receipt.rewardsProvenance.confidence, "provider_reported");
      assert.match(receipt.rewardsProvenance.note, /cannot become verified/);
    });
  });

  // -----------------------------------------------------------------------
  // Signing guard
  // -----------------------------------------------------------------------
  describe("isStakingSignable", () => {
    it("refuses signing for all current routes (none are executable)", () => {
      const routes = getStakingRoutes("mainnet");
      for (const route of routes) {
        const result = isStakingSignable(route);
        assert.equal(result.canSign, false);
        assert.ok(result.reason.length > 0);
      }
    });

    it("would permit signing for a hypothetical executable route", () => {
      const base = getStakingRoutes("mainnet")[0];
      const mockRoute: StakingRouteView = Object.assign({}, base, {
        executable: true as const,
        broadcastAllowed: true as const,
      });
      const result = isStakingSignable(mockRoute);
      assert.equal(result.canSign, true);
    });
  });
});
