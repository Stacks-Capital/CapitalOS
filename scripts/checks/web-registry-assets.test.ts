import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASSETS, BITFLOW_ALLOWED_POOLS, CAPABILITIES } from "../../packages/config/src/deployments.ts";
import { ALLOWED_POOL_PRINCIPALS, SBTC_DEF, USDCX_DEF } from "../../apps/web/src/liquidityState.ts";
import { getStakingRoutes } from "../../apps/web/src/stakingState.ts";
import { CANONICAL_SWAP_ASSETS, reconcileSwapAssets } from "../../apps/web/src/swapState.ts";

/*
 * apps/web is not allowed to import @stacks-capital/config, so it keeps its own copy of the
 * contract principals it reconciles quotes against. That copy went wrong once: the swap screen
 * carried a USDCx principal ending in "-token" and two testnet principals invented by rewriting
 * the mainnet prefix, which made every swap fail reconciliation and blocked signing on both
 * networks. This check keeps the copy and the signed registry equal.
 */

function registryAsset(protocol: string, network: "mainnet" | "testnet") {
  const asset = ASSETS.find((a) => a.protocol === protocol && a.network === network);
  assert.ok(asset, `the registry has no ${protocol} asset on ${network}`);
  return asset;
}

describe("the web app's asset table matches the signed registry", () => {
  it("pins every swap principal and asset name", () => {
    for (const [protocol, canonical] of [
      ["sbtc", CANONICAL_SWAP_ASSETS.sbtc],
      ["usdcx", CANONICAL_SWAP_ASSETS.usdcx],
    ] as const) {
      for (const network of ["mainnet", "testnet"] as const) {
        const asset = registryAsset(protocol, network);
        const expected = network === "mainnet" ? canonical.mainnetContract : canonical.testnetContract;
        assert.equal(expected, asset.contractId, `${protocol} ${network} principal`);
        assert.equal(canonical.assetName, asset.assetName, `${protocol} ${network} asset name`);
      }
    }
  });

  it("pins the liquidity screen's mainnet principals", () => {
    assert.equal(SBTC_DEF.contractId, registryAsset("sbtc", "mainnet").contractId);
    assert.equal(USDCX_DEF.contractId, registryAsset("usdcx", "mainnet").contractId);
  });

  it("reconciles a quote carrying the registry's own asset identifiers", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      const result = reconcileSwapAssets(
        {
          input: [{ asset: registryAsset("sbtc", network).id, quantity: "1000000" }],
          expectedOutput: [{ asset: registryAsset("usdcx", network).id, quantity: "700000000" }],
        },
        network,
      );
      assert.equal(result.reconciled, true, `${network}: ${result.reason ?? ""}`);
    }
  });

  it("refuses a quote whose asset is on the other network", () => {
    const result = reconcileSwapAssets(
      {
        input: [{ asset: registryAsset("sbtc", "testnet").id, quantity: "1000000" }],
        expectedOutput: [{ asset: registryAsset("usdcx", "mainnet").id, quantity: "700000000" }],
      },
      "mainnet",
    );
    assert.equal(result.reconciled, false);
  });

  it("refuses a look-alike principal that only shares a prefix", () => {
    const usdcx = registryAsset("usdcx", "mainnet");
    const lookAlike = `stacks:mainnet:contract:${usdcx.contractId}-token:${usdcx.assetName}`;
    const result = reconcileSwapAssets(
      {
        input: [{ asset: registryAsset("sbtc", "mainnet").id, quantity: "1000000" }],
        expectedOutput: [{ asset: lookAlike, quantity: "700000000" }],
      },
      "mainnet",
    );
    assert.equal(result.reconciled, false);
  });
});

/*
 * The liquidity and staking screens carry their own copies of registry state too. Both are
 * currently empty or unavailable, which is correct, but nothing made them follow the registry
 * when it changes. These checks fail the moment the registry enables something the screens
 * still present as unavailable, which is the point at which they need wiring up.
 */
describe("the web app's capability copies follow the registry", () => {
  it("keeps the liquidity pool allowlist equal to the registry's", () => {
    assert.deepEqual([...ALLOWED_POOL_PRINCIPALS], [...BITFLOW_ALLOWED_POOLS]);
  });

  it("marks a staking route unavailable exactly when the registry has no enabled capability", () => {
    // Stated both ways on purpose. Only checking the enabled direction would pass vacuously
    // today, because no staking protocol is enabled yet, and would keep passing if a route were
    // quietly hardcoded as executable.
    for (const network of ["mainnet", "testnet"] as const) {
      for (const route of getStakingRoutes(network)) {
        const enabled = CAPABILITIES.some(
          (capability) =>
            capability.protocol === route.protocol && capability.network === network && capability.state === "enabled",
        );
        assert.equal(
          route.capabilityState === "unavailable",
          !enabled,
          enabled
            ? `the registry enables ${route.protocol} on ${network}, but the staking screen hardcodes it unavailable`
            : `the staking screen offers ${route.protocol} on ${network}, but the registry enables no such capability`,
        );
        assert.equal(route.executable, enabled, `${route.protocol} on ${network} executable flag`);
      }
    }
  });
});
