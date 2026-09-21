import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateZestCredit, zestCreditAvailability, ZEST_CREDIT_ACTIONS } from "./creditLifecycle.ts";

describe("K28 Zest credit lifecycle", () => {
  it("refuses every user credit action on both networks without inventing contracts", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      for (const action of ZEST_CREDIT_ACTIONS) {
        const availability = zestCreditAvailability(network, action);
        assert.equal(availability.executable, false);
        assert.equal(availability.state, "unavailable");
        assert.equal(availability.redirect.marketId, "granite.sbtc.isolated");
        const lifecycle = evaluateZestCredit({ action, network, idempotencyKey: `${action}-1` });
        assert.equal(lifecycle.broadcastAllowed, false);
        assert.equal(lifecycle.state, "unavailable");
        assert.equal(lifecycle.complete, false);
      }
    }
  });

  it("names reviewed Zest contracts and keeps borrow/repay unavailable on mainnet", () => {
    const borrow = zestCreditAvailability("mainnet", "borrow");
    assert.match(borrow.reviewedContracts.earnVault ?? "", /v0-vault-sbtc/);
    assert.match(borrow.reviewedContracts.debtVault ?? "", /v0-vault-usdc/);
    assert.match(borrow.reviewedContracts.supersededMarket ?? "", /v0-4-market/);
    assert.match(borrow.reason, /no user collateral-add, borrow, or repay/i);
  });

  it("does not rebrand earn supply as isolated collateral", () => {
    const supply = zestCreditAvailability("mainnet", "supply");
    assert.match(supply.reason, /earn vault path/);
    assert.match(supply.redirect.note, /Granite v0-8-market/);
  });
});
