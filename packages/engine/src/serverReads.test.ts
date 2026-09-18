import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORACLE_MAX_AGE_MS } from "@stacks-capital/core";
import { createExecutionEngine } from "./engine.ts";
import { encodeAscii, diaOracleHex, clarityUintAfter } from "./clarity.ts";
import { loadServerReads } from "./serverReads.ts";

const PAUSE =
  "0x070c00000006066163637275650406626f72726f7704076465706f7369740409666c6173686c6f616e040672656465656d0405726570617904";
const EGROUP =
  "0x070c0000000914424f52524f572d44495341424c45442d4d41534b01000000000000000000000000000000000d4c49512d43555256452d455850020000000227100f4c49512d50454e414c54592d4d4158020000000203e80f4c49512d50454e414c54592d4d494e020000000202ee0a4c54562d424f52524f5702000000021f400c4c54562d4c49512d46554c4c020000000223280f4c54562d4c49512d5041525449414c02000000022134044d41534b0100000000000000040000000000000004026964020000000102";
const OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
const NOW = new Date("2026-09-15T12:00:00.000Z");

function uintHex(value: bigint): string {
  return `0x0701${value.toString(16).padStart(32, "0")}`;
}

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function feedFromArg(arg: string): string | undefined {
  if (arg === encodeAscii("BTC/USD")) return "BTC/USD";
  if (arg === encodeAscii("sBTC/USD")) return "sBTC/USD";
  if (arg === encodeAscii("USDC/USD")) return "USDC/USD";
  return undefined;
}

function fetchFor(prices: {
  btc: bigint;
  sbtc: bigint;
  usdc: bigint;
  btcTs: bigint;
  sbtcTs: bigint;
  usdcTs: bigint;
}): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/limits")) {
      return json({ perDepositMinimum: 1000, perWithdrawalCap: 50100000000, pegCap: 2100000000000000 });
    }
    if (url.includes("/get-pause-states")) return json({ okay: true, result: PAUSE });
    if (url.includes("/get-total-assets")) return json({ okay: true, result: uintHex(66_022_279_734n) });
    if (url.includes("/get-cap-supply")) return json({ okay: true, result: uintHex(500_000_000_000n) });
    if (url.includes("/convert-to-shares")) return json({ okay: true, result: uintHex(100_000_000n) });
    if (url.includes("/resolve")) return json({ okay: true, result: EGROUP });
    if (url.includes("/get-balance")) return json({ okay: true, result: uintHex(0n) });
    if (url.includes("/get-value")) {
      const body = JSON.parse(String(init?.body)) as { arguments?: string[] };
      const feed = feedFromArg(body.arguments?.[0] ?? "");
      if (feed === "BTC/USD") return json({ okay: true, result: diaOracleHex(prices.btc, prices.btcTs) });
      if (feed === "sBTC/USD") return json({ okay: true, result: diaOracleHex(prices.sbtc, prices.sbtcTs) });
      if (feed === "USDC/USD") return json({ okay: true, result: diaOracleHex(prices.usdc, prices.usdcTs) });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

describe("Clarity codecs", () => {
  it("encodes DIA string-ascii arguments and reads DIA uint fields", () => {
    assert.equal(encodeAscii("BTC/USD"), "0x0d000000074254432f555344");
    const hex = diaOracleHex(7_654_982_828_380n, 1_789_674_425_551n);
    assert.equal(clarityUintAfter(hex, "value"), 7_654_982_828_380n);
    assert.equal(clarityUintAfter(hex, "timestamp"), 1_789_674_425_551n);
  });
});

describe("loadServerReads", () => {
  it("is mainnet-only, uses DIA, and fail-closes Granite when USDC/USD is unset", async () => {
    await assert.rejects(
      () =>
        loadServerReads({
          network: "testnet",
          fetch: fetchFor({ btc: 0n, sbtc: 0n, usdc: 0n, btcTs: 0n, sbtcTs: 0n, usdcTs: 0n }),
        }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "CAPABILITY_DISABLED",
    );

    const ts = BigInt(NOW.getTime());
    const reads = await loadServerReads({
      network: "mainnet",
      owner: OWNER,
      now: NOW,
      fetch: fetchFor({
        btc: 7_654_982_828_380n,
        sbtc: 1n,
        usdc: 0n,
        btcTs: ts,
        sbtcTs: ts - BigInt(44 * 24 * 60 * 60 * 1000),
        usdcTs: 0n,
      }),
    });
    assert.equal(reads.source, "hiro+emily+dia");
    assert.equal(reads.oracle?.sbtc.stale, false);
    assert.equal(reads.oracle?.sbtc.source, "dia-oracle:BTC/USD");
    assert.equal(reads.oracle?.usdcx.stale, true);
    assert.equal(reads.swap?.stale, true);

    const engine = createExecutionEngine({ network: "mainnet", reads, owner: OWNER, now: NOW });
    assert.equal(
      engine.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" }).quote.executable,
      true,
    );
    assert.throws(
      () => engine.quote({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ORACLE_STALE",
    );
    assert.throws(
      () => engine.quote({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ORACLE_STALE",
    );
  });

  it("quotes Granite when DIA BTC/USD and USDC/USD are both fresh", async () => {
    const ts = BigInt(NOW.getTime());
    const reads = await loadServerReads({
      network: "mainnet",
      owner: OWNER,
      now: NOW,
      fetch: fetchFor({
        btc: 10_000_000_000_000n,
        sbtc: 0n,
        usdc: 100_000_000n,
        btcTs: ts,
        sbtcTs: 0n,
        usdcTs: ts,
      }),
    });
    assert.equal(reads.oracle?.sbtc.stale, false);
    assert.equal(reads.oracle?.usdcx.stale, false);
    assert.ok(NOW.getTime() - Date.parse(reads.oracle?.usdcx.observedAt ?? "") <= ORACLE_MAX_AGE_MS);

    const engine = createExecutionEngine({
      network: "mainnet",
      reads: { ...reads, position: { collateral: "100000000", debt: "0" } },
      owner: OWNER,
      now: NOW,
    });
    const borrow = engine.quoteAndPlan({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "50000000000" });
    assert.equal(borrow.quote.executable, true);
    assert.equal(
      borrow.quote.expectedOutput[0]?.asset.identity.kind === "contract" &&
        borrow.quote.expectedOutput[0].asset.identity.assetName,
      "usdcx-token",
    );
  });
});
