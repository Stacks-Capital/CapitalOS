import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Market } from "@stacks-capital/client";
import { type Balance, buildPortfolio, type Position } from "./holdings.ts";

const SBTC = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
const ZFT = "stacks:mainnet:contract:SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc:zft";

const VAULT: Market = {
  id: "zest.sbtc.vault",
  network: "mainnet",
  protocol: "zest",
  suppliedAssetId: SBTC,
  receiptAssetId: ZFT,
  capabilities: [],
};

const balance = (assetId: string, quantity: string | null, warnings: string[] = []): Balance => ({
  assetId,
  quantity,
  stale: quantity === null,
  warnings,
});

const supplied = (quantity: string | null): Position => ({
  marketId: "zest.sbtc.vault",
  kind: "supplied",
  assetId: SBTC,
  quantity,
  stale: quantity === null,
  warnings: quantity === null ? ["supplied balance is unknown"] : [],
});

describe("receipt and underlying", () => {
  it("counts the position once and shows the receipt as evidence", () => {
    const { rows, totals } = buildPortfolio({
      balances: [balance(SBTC, "100000000"), balance(ZFT, "48000000")],
      positions: [supplied("50000000")],
      markets: [VAULT],
    });

    const counted = rows.filter((row) => row.countsTowardTotal);
    assert.deepEqual(
      counted.map((row) => [row.kind, row.quantity]),
      [
        ["wallet", "100000000"],
        ["supplied", "50000000"],
      ],
    );
    // 1.0 sBTC in the wallet plus 0.5 supplied. The 0.48 receipt is the same money as the position.
    assert.deepEqual(totals, [{ assetId: SBTC, quantity: "150000000", incomplete: false, warnings: [] }]);

    const receipt = rows.find((row) => row.kind === "receipt");
    assert.equal(receipt?.countsTowardTotal, false);
    assert.match(receipt?.warnings.join(" ") ?? "", /not counted again/);
  });

  it("never values a receipt on its own when the position is missing", () => {
    const { rows, totals } = buildPortfolio({
      balances: [balance(ZFT, "48000000")],
      positions: [],
      markets: [VAULT],
    });
    const receipt = rows[0];
    assert.equal(receipt?.kind, "receipt");
    assert.equal(receipt?.countsTowardTotal, false);
    assert.match(receipt?.warnings.join(" ") ?? "", /needs the vault share rate/);
    assert.deepEqual(totals, []);
  });

  it("treats an unknown token as a plain wallet balance", () => {
    const { rows } = buildPortfolio({
      balances: [balance("stacks:mainnet:native:stx", "5")],
      positions: [],
      markets: [VAULT],
    });
    assert.deepEqual(
      rows.map((row) => [row.kind, row.countsTowardTotal]),
      [["wallet", true]],
    );
  });
});

describe("partial data", () => {
  it("makes the total unknown when a part is unknown, never zero", () => {
    const { totals } = buildPortfolio({
      balances: [balance(SBTC, null, ["balance is unavailable"])],
      positions: [supplied("50000000")],
      markets: [VAULT],
    });
    assert.deepEqual(totals, [
      { assetId: SBTC, quantity: null, incomplete: true, warnings: ["balance is unavailable"] },
    ]);
  });

  it("keeps an unknown position out of the total and says why", () => {
    const { rows, totals } = buildPortfolio({ balances: [], positions: [supplied(null)], markets: [VAULT] });
    assert.equal(rows[0]?.quantity, null);
    assert.equal(totals[0]?.incomplete, true);
    assert.deepEqual(totals[0]?.warnings, ["supplied balance is unknown"]);
  });

  it("returns nothing at all when there is nothing to show", () => {
    assert.deepEqual(buildPortfolio({ balances: [], positions: [], markets: [VAULT] }), { rows: [], totals: [] });
  });
});

describe("debt", () => {
  it("is listed but never added to what the wallet owns", () => {
    const debt: Position = {
      marketId: "granite.sbtc.isolated",
      kind: "debt",
      assetId: SBTC,
      quantity: "10000000",
      stale: false,
      warnings: [],
    };
    const { rows, totals } = buildPortfolio({
      balances: [balance(SBTC, "100000000")],
      positions: [debt],
      markets: [VAULT],
    });
    assert.equal(rows.find((row) => row.kind === "debt")?.countsTowardTotal, false);
    assert.equal(totals[0]?.quantity, "100000000");
  });
});
