import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateStaking, stakingAvailability, STAKING_ACTIONS } from "./lifecycle.ts";

describe("K33 stacking and staking routes", () => {
  it("keeps stake unavailable on both networks and documents unstake stays gated", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      for (const action of STAKING_ACTIONS) {
        const availability = stakingAvailability(network, action);
        assert.equal(availability.executable, false);
        const lifecycle = evaluateStaking({ action, network, idempotencyKey: "1" });
        assert.equal(lifecycle.broadcastAllowed, false);
        assert.equal(lifecycle.state, "unavailable");
        assert.match(lifecycle.warnings.join(" "), /lockup signing|disabled/i);
        assert.match(lifecycle.warnings.join(" "), /not sBTC DeFi/i);
        assert.match(lifecycle.warnings.join(" "), /unstake/);
      }
    }
  });
});
