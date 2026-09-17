import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCapitalOS } from "./client.ts";
import { loadLiveReads } from "./liveReads.ts";

const PAUSE =
  "0x070c00000006066163637275650406626f72726f7704076465706f7369740409666c6173686c6f616e040672656465656d0405726570617904";
const EGROUP =
  "0x070c0000000914424f52524f572d44495341424c45442d4d41534b01000000000000000000000000000000000d4c49512d43555256452d455850020000000227100f4c49512d50454e414c54592d4d4158020000000203e80f4c49512d50454e414c54592d4d494e020000000202ee0a4c54562d424f52524f5702000000021f400c4c54562d4c49512d46554c4c020000000223280f4c54562d4c49512d5041525449414c02000000022134044d41534b0100000000000000040000000000000004026964020000000102";
const OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";

function uintHex(value: bigint): string {
  return `0x0701${value.toString(16).padStart(32, "0")}`;
}

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

const fetchImpl: typeof fetch = async (input) => {
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
  throw new Error(`unexpected fetch ${url}`);
};

describe("loadLiveReads", () => {
  it("is mainnet-only and fail-closes Granite/Bitflow without Pyth or a pinned pool", async () => {
    await assert.rejects(
      () => loadLiveReads({ network: "testnet", fetch: fetchImpl }),
      (error: unknown) => {
        return typeof error === "object" && error !== null && "code" in error && error.code === "CAPABILITY_DISABLED";
      },
    );

    const now = new Date("2026-09-15T12:00:00.000Z");
    const reads = await loadLiveReads({ network: "mainnet", owner: OWNER, now, fetch: fetchImpl });
    assert.equal(reads.source, "hiro+emily");
    assert.equal(reads.vault?.pausedDeposit, false);
    assert.equal(reads.riskParams?.ltvBorrowBps, "8000");
    assert.equal(reads.oracle?.sbtc.stale, true);
    assert.equal(reads.swap?.stale, true);
    assert.equal(reads.swap?.poolId, "");
    assert.equal(reads.balances?.sbtc, "0");

    const os = createCapitalOS({ network: "mainnet", reads, owner: OWNER, now });
    const supply = os.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });
    assert.equal(supply.quote.executable, true);
    assert.throws(
      () => os.quote({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }),
      (error: unknown) => {
        return typeof error === "object" && error !== null && "code" in error && error.code === "ORACLE_STALE";
      },
    );
    assert.throws(
      () => os.quote({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" }),
      (error: unknown) => {
        return typeof error === "object" && error !== null && "code" in error && error.code === "ORACLE_STALE";
      },
    );
  });
});
