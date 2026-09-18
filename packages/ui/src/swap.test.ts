import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OracleQuoteView, QuotedPlan } from "@stacks-capital/client";
import { canApprove, priceImpactBps, REFRESH_MARGIN_SECONDS, swapView } from "./swap.ts";

const SBTC = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
const USDCX = "stacks:mainnet:contract:SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token:usdcx-token";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const ASSETS = { sentFeed: "BTC/USD", receivedFeed: "USDC/USD", sentDecimals: 8, receivedDecimals: 6 };

const price = (feedKey: string, value: string | null, overrides: Partial<OracleQuoteView> = {}): OracleQuoteView => ({
  feedKey,
  price: value,
  scale: 8,
  publishedAt: "2026-09-18T11:59:30.000Z",
  observedAt: "2026-09-18T11:59:30.000Z",
  source: "dia-oracle",
  stale: false,
  warnings: [],
  ...overrides,
});

// 0.01 sBTC in, 700 USDCx out, with BTC at 70,000 and USDC at 1.00: a fair swap.
function quoted(overrides: Partial<QuotedPlan["quote"]> = {}): QuotedPlan {
  return {
    quote: {
      id: "q_1",
      action: "swap",
      marketId: "bitflow.sbtc-usdcx",
      network: "mainnet",
      input: [{ asset: SBTC, quantity: "1000000" }],
      expectedOutput: [{ asset: USDCX, quantity: "700000000" }],
      minimumOutput: { asset: USDCX, quantity: "696500000" },
      fees: [],
      snapshots: [],
      warnings: [],
      executable: true,
      expiresAt: "2026-09-18T12:01:00.000Z",
      registryVersion: "0.1.0",
      adapterVersion: "bitflow-swap@0.1.0",
      ...overrides,
    },
    plan: {
      id: "p_1",
      quoteId: "q_1",
      network: "mainnet",
      steps: [
        {
          id: "step_1",
          payload: {
            kind: "stacks_contract_call",
            contractId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2",
            functionName: "swap-x-for-y",
          },
          expectedAssetEffects: [],
          dependsOn: [],
        },
      ],
      reviewSummary: "Swap 0.01 sBTC for USDCx",
      expiresAt: "2026-09-18T12:01:00.000Z",
      registryVersion: "0.1.0",
      adapterVersion: "bitflow-swap@0.1.0",
    },
  };
}

const PRICES = [price("BTC/USD", "7000000000000"), price("USDC/USD", "100000000")];

describe("price impact", () => {
  it("is zero when the quote matches the oracle rate", () => {
    const view = swapView(quoted(), PRICES, ASSETS, NOW);
    assert.equal(view.impactBps, "0");
    assert.equal(view.impactNote, null);
  });

  it("is positive when the quote gives less than the oracle rate", () => {
    const view = swapView(quoted({ expectedOutput: [{ asset: USDCX, quantity: "693000000" }] }), PRICES, ASSETS, NOW);
    // 1% worse than the oracle rate.
    assert.equal(view.impactBps, "100");
  });

  it("is unknown when a price is missing or stale, rather than zero", () => {
    const missing = swapView(quoted(), [price("BTC/USD", "7000000000000"), price("USDC/USD", null)], ASSETS, NOW);
    assert.equal(missing.impactBps, null);
    assert.match(missing.impactNote ?? "", /needs a fresh price for both sides/);

    const stale = swapView(
      quoted(),
      [price("BTC/USD", "7000000000000", { stale: true }), price("USDC/USD", "100000000")],
      ASSETS,
      NOW,
    );
    assert.equal(stale.impactBps, null);
  });

  it("refuses to compute an impact from an empty side", () => {
    assert.equal(
      priceImpactBps({
        sentQuantity: 0n,
        sentDecimals: 8n,
        receivedQuantity: 1n,
        receivedDecimals: 6n,
        sentPrice: { price: 1n, scale: 8n },
        receivedPrice: { price: 1n, scale: 8n },
      }),
      null,
    );
  });
});

describe("what the screen shows", () => {
  it("names the route, what is sent, expected and guaranteed", () => {
    const view = swapView(quoted(), PRICES, ASSETS, NOW);
    assert.deepEqual(view.route, [
      { contractId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2", functionName: "swap-x-for-y" },
    ]);
    assert.equal(view.sending, `1000000 ${SBTC}`);
    assert.equal(view.expectedReceived, `700000000 ${USDCX}`);
    assert.equal(view.minimumReceived, `696500000 ${USDCX}`);
  });

  it("passes the quote's own warnings through", () => {
    const view = swapView(quoted({ warnings: ["pool liquidity is thin"] }), PRICES, ASSETS, NOW);
    assert.deepEqual(view.warnings, ["pool liquidity is thin"]);
  });
});

describe("expiry", () => {
  it("counts down while the quote is good", () => {
    const view = swapView(quoted(), PRICES, ASSETS, NOW);
    assert.equal(view.expiresInSeconds, 60);
    assert.equal(view.expired, false);
    assert.equal(view.needsRefresh, false);
    assert.equal(canApprove(view, quoted()), true);
  });

  it("requires a refresh before approval once it is close to expiry", () => {
    const close = new Date(new Date("2026-09-18T12:01:00.000Z").getTime() - REFRESH_MARGIN_SECONDS * 1000);
    const view = swapView(quoted(), PRICES, ASSETS, close);
    assert.equal(view.expired, false);
    assert.equal(view.needsRefresh, true);
    assert.equal(canApprove(view, quoted()), false);
  });

  it("refuses an expired quote outright", () => {
    const view = swapView(quoted(), PRICES, ASSETS, new Date("2026-09-18T12:01:30.000Z"));
    assert.equal(view.expired, true);
    assert.equal(view.expiresInSeconds, 0);
    assert.equal(canApprove(view, quoted()), false);
  });

  it("refuses a quote the market cannot execute, or one with no floor on what is received", () => {
    const blocked = quoted({ executable: false });
    assert.equal(canApprove(swapView(blocked, PRICES, ASSETS, NOW), blocked), false);

    const withMinimum = quoted();
    const { minimumOutput: _floor, ...withoutFloor } = withMinimum.quote;
    const noMinimum: QuotedPlan = { ...withMinimum, quote: withoutFloor };
    const view = swapView(noMinimum, PRICES, ASSETS, NOW);
    assert.equal(view.minimumReceived, null);
    assert.equal(canApprove(view, noMinimum), false);
  });
});
