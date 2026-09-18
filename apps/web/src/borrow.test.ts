import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketRisk } from "@stacks-capital/client";
import { deltasFor, projectBorrow, QUOTE_ACTION } from "./borrow.ts";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const FRESH = "2026-09-18T11:59:00.000Z";

function risk(overrides: Partial<MarketRisk> = {}): MarketRisk {
  return {
    marketId: "granite.sbtc.isolated",
    params: {
      ltvBorrowBps: "7000",
      ltvLiqBps: "8000",
      bufferBps: "500",
      collateralDecimals: 8,
      debtDecimals: 6,
    },
    collateralOracle: {
      feedKey: "BTC/USD",
      price: "7000000000000",
      scale: 8,
      publishedAt: FRESH,
      observedAt: FRESH,
      source: "dia-oracle",
      stale: false,
      warnings: [],
    },
    debtOracle: {
      feedKey: "USDC/USD",
      price: "100000000",
      scale: 8,
      publishedAt: FRESH,
      observedAt: FRESH,
      source: "dia-oracle",
      stale: false,
      warnings: [],
    },
    // 1 sBTC of collateral, 10,000 USDC of debt.
    position: { collateral: "100000000", debt: "10000000000", stale: false, warnings: [] },
    warnings: [],
    ...overrides,
  };
}

describe("what an action moves", () => {
  it("maps each control to the right side and direction", () => {
    assert.deepEqual(deltasFor("collateral_add", 5n), { collateral: 5n, debt: 0n });
    assert.deepEqual(deltasFor("collateral_remove", 5n), { collateral: -5n, debt: 0n });
    assert.deepEqual(deltasFor("borrow", 5n), { collateral: 0n, debt: 5n });
    assert.deepEqual(deltasFor("repay", 5n), { collateral: 0n, debt: -5n });
    assert.deepEqual(QUOTE_ACTION.borrow, "borrow");
    assert.deepEqual(QUOTE_ACTION.collateral_remove, "withdraw_supply");
  });
});

describe("projecting health", () => {
  it("shows the position after borrowing more", () => {
    const result = projectBorrow(risk(), { action: "borrow", amount: "5000000000" }, NOW);
    assert.equal(result.canProceed, true);
    // 70,000 USD collateral against 15,000 USD debt after borrowing 5,000 more.
    assert.equal(result.health?.debtUsd, 1_500_000_000_000n);
    assert.ok((result.health?.currentLtvBps ?? 0n) > 2000n && (result.health?.currentLtvBps ?? 0n) < 2200n);
    assert.equal(result.health?.healthy, true);
  });

  it("refuses a borrow that would pass the limit, and says so", () => {
    const result = projectBorrow(risk(), { action: "borrow", amount: "50000000000" }, NOW);
    assert.equal(result.canProceed, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes("above the borrow limit")));
  });

  it("warns when an action lands inside the safety buffer without blocking it", () => {
    // Borrowing up to about 68% LTV is allowed but sits inside the 5% buffer under the 70% limit.
    const result = projectBorrow(risk(), { action: "borrow", amount: "37000000000" }, NOW);
    assert.equal(result.canProceed, true);
    assert.ok(result.notes.some((note) => note.includes("safety buffer")));
  });

  it("shows repaying and adding collateral improving the position", () => {
    const repaid = projectBorrow(risk(), { action: "repay", amount: "5000000000", walletBalance: "10000000000" }, NOW);
    const added = projectBorrow(
      risk(),
      { action: "collateral_add", amount: "50000000", walletBalance: "100000000" },
      NOW,
    );
    assert.equal(repaid.health?.debtUsd, 500_000_000_000n);
    assert.ok((added.health?.currentLtvBps ?? 0n) < (repaid.health?.liquidationThresholdBps ?? 0n));
  });
});

describe("states that block signing", () => {
  const blocked = (overrides: Partial<MarketRisk>, amount = "1000000") =>
    projectBorrow(risk(overrides), { action: "borrow", amount }, NOW);

  it("blocks on a stale or missing price", () => {
    const stale = blocked({
      collateralOracle: { ...risk().collateralOracle, publishedAt: "2026-09-18T11:00:00.000Z" },
    });
    assert.equal(stale.canProceed, false);
    assert.ok(stale.blockers.some((blocker) => blocker.includes("BTC/USD price is stale")));

    const missing = blocked({ debtOracle: { ...risk().debtOracle, price: null } });
    assert.ok(missing.blockers.some((blocker) => blocker.includes("No price for USDC/USD")));

    const flagged = blocked({ collateralOracle: { ...risk().collateralOracle, stale: true } });
    assert.equal(flagged.canProceed, false);
  });

  it("blocks when the protocol's risk parameters are unavailable", () => {
    const result = blocked({ params: null, warnings: ["Risk parameters are unavailable: HTTP 503"] });
    assert.equal(result.canProceed, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes("risk parameters could not be read")));
    assert.ok(result.notes.some((note) => note.includes("HTTP 503")));
  });

  it("blocks when the current position is unknown, rather than assuming zero", () => {
    const result = blocked({
      position: { collateral: null, debt: null, stale: true, warnings: ["granite.sbtc.isolated was not read"] },
    });
    assert.equal(result.canProceed, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes("current position in this market is unknown")));
  });

  it("blocks on an amount that is not a whole number of base units", () => {
    for (const amount of ["", "1.5", "-4", "abc"]) {
      const result = projectBorrow(risk(), { action: "borrow", amount }, NOW);
      assert.equal(result.canProceed, false, amount);
      assert.ok(result.blockers.some((blocker) => blocker.includes("Enter an amount")));
    }
    const zero = projectBorrow(risk(), { action: "borrow", amount: "0" }, NOW);
    assert.ok(zero.blockers.some((blocker) => blocker.includes("greater than zero")));
  });

  it("blocks sending more than the wallet holds, and says when the balance is unknown", () => {
    const tooMuch = projectBorrow(
      risk(),
      { action: "collateral_add", amount: "200000000", walletBalance: "100000000" },
      NOW,
    );
    assert.equal(tooMuch.canProceed, false);
    assert.ok(tooMuch.blockers.some((blocker) => blocker.includes("more than your wallet holds")));

    const unknown = projectBorrow(risk(), { action: "collateral_add", amount: "1", walletBalance: null }, NOW);
    assert.ok(unknown.notes.some((note) => note.includes("wallet balance is unknown")));
    assert.equal(unknown.canProceed, true);
  });

  it("blocks a paused market and a borrow above available liquidity", () => {
    const paused = projectBorrow(risk(), { action: "borrow", amount: "1000000", paused: true }, NOW);
    assert.equal(paused.canProceed, false);
    assert.ok(paused.blockers.some((blocker) => blocker.includes("paused")));

    const dry = projectBorrow(risk(), { action: "borrow", amount: "5000000000", availableLiquidity: "1000" }, NOW);
    assert.equal(dry.canProceed, false);
    assert.ok(dry.blockers.some((blocker) => blocker.includes("liquidity")));
  });

  it("treats repay-all as the current debt and refuses an overpay", () => {
    const all = projectBorrow(risk(), { action: "repay", amount: "max", walletBalance: "10000000000" }, NOW);
    assert.equal(all.canProceed, true);
    assert.equal(all.health?.debtUsd, 0n);

    const over = projectBorrow(risk(), { action: "repay", amount: "20000000000", walletBalance: "99999999999" }, NOW);
    assert.ok(over.blockers.some((blocker) => blocker.includes("more than you owe")));
  });
});
