import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contract } from "@stacks-capital/config";
import {
  FIXTURE_GOLDEN_ADDRESSES,
  GOLDEN_FIXTURE_OWNER,
  reconcileFixtureGoldenAddresses,
  reconcileGoldenPositions,
  reconcileGoldenPortfolioAccounting,
} from "./goldenAddresses.ts";

describe("K38 golden-address reconciliation", () => {
  it("matches independent fixture expectations against adapter reads", () => {
    const reports = reconcileFixtureGoldenAddresses();
    assert.ok(reports.length >= 3);
    for (const report of reports) {
      assert.equal(report.matched, true, `${report.id}: ${report.mismatches.join("; ")}`);
      assert.ok(report.limitations.length > 0);
    }
    const user = reports.find((report) => report.id === "fixture-user-granite");
    assert.equal(user?.observed.find((row) => row.kind === "collateral")?.quantity, "100000000");
  });

  it("fail-closes when an independent expectation disagrees", () => {
    const checked = reconcileGoldenPositions(
      [{ marketId: "granite.sbtc.isolated", kind: "collateral", quantity: "1" }],
      [{ marketId: "granite.sbtc.isolated", kind: "collateral", quantity: "2" }],
    );
    assert.equal(checked.matched, false);
    assert.match(checked.mismatches.join(" "), /expected 1 observed 2/);
  });

  it("pins protocol golden principals to the signed registry", () => {
    const zest = FIXTURE_GOLDEN_ADDRESSES.find((row) => row.id === "protocol-zest-vault");
    assert.equal(zest?.address, contract("zest", "v0-vault-sbtc", "mainnet").contractId);
    assert.equal(zest?.address.startsWith("SP"), true);
    assert.ok(FIXTURE_GOLDEN_ADDRESSES.some((row) => row.address === GOLDEN_FIXTURE_OWNER));
  });

  it("I26 reconciles golden address portfolio against explorer and protocol reads", () => {
    const portfolioReports = reconcileGoldenPortfolioAccounting();
    assert.ok(portfolioReports.length > 0);
    for (const report of portfolioReports) {
      assert.equal(report.matched, true, report.mismatches.join("; "));
      assert.equal(report.explorerBalanceMatched, true);
      assert.equal(report.protocolPositionsMatched, true);
      assert.equal(report.linkedCollateralMatched, true);
      assert.ok(report.netWorthUsd !== null);
      assert.ok(report.grossAssetsUsd !== null);
      assert.ok(report.grossDebtUsd !== null);
      if (report.netWorthUsd && report.grossAssetsUsd && report.grossDebtUsd) {
        assert.equal(BigInt(report.netWorthUsd) === BigInt(report.grossAssetsUsd) - BigInt(report.grossDebtUsd), true);
      }
    }
  });
});
