import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHiro, decodeTuple, decodeUint, tupleBool, tupleString, tupleUint } from "./hiro.ts";

// Recorded from mainnet on 2026-09-17 (Granite sBTC vault and the DIA oracle Granite itself reads).
const PAUSE_STATES =
  "0x070c00000006066163637275650406626f72726f7704076465706f7369740409666c6173686c6f616e040672656465656d0405726570617904";
const TOTAL_ASSETS = "0x070100000000000000000000000f5fd643d9";
const AVAILABLE_ASSETS = "0x0100000000000000000000000daa6428a4";
const BTC_USD =
  "0x070c000000020974696d657374616d70010000000000000000000001a0b0e88ccf0576616c7565010000000000000000000006f65088415c";
const USDC_USD =
  "0x070c000000020974696d657374616d7001000000000000000000000000000000000576616c75650100000000000000000000000000000000";
const DEPOSIT_EVENT =
  "0x0c0000000306616374696f6e0d000000076465706f7369740663616c6c657206165423cdfe275d8bb19862b0cf342c616a7a18c8420b76302d382d6d61726b657404646174610c0000000506616d6f756e740100000000000000000000000000001962066173736574730100000000000000000000000f5fc768c8096465706f7369746f7206165423cdfe275d8bb19862b0cf342c616a7a18c8420b76302d382d6d61726b657409726563697069656e740516756f6730289f363631aa3c732974504560192bfa0d7368617265732d6d696e746564010000000000000000000000000000195e";

describe("Clarity decoding", () => {
  it("reads uints inside and outside a response", () => {
    assert.equal(decodeUint(TOTAL_ASSETS), 66032387033n);
    assert.equal(decodeUint(AVAILABLE_ASSETS), 58693265572n);
  });

  it("reads tuple fields by name and reports missing ones as null", () => {
    const pause = decodeTuple(PAUSE_STATES);
    assert.equal(tupleBool(pause, "deposit"), false);
    assert.equal(tupleBool(pause, "redeem"), false);
    assert.equal(tupleBool(pause, "not-a-field"), null);

    const price = decodeTuple(BTC_USD);
    assert.equal(tupleUint(price, "value"), 7654982828380n);
    assert.equal(tupleUint(price, "timestamp"), 1789674425551n);
  });

  it("reads a zero oracle entry as zero, which the caller stores as unknown", () => {
    const empty = decodeTuple(USDC_USD);
    assert.equal(tupleUint(empty, "value"), 0n);
    assert.equal(tupleUint(empty, "timestamp"), 0n);
  });

  it("reads the action name from a contract print event", () => {
    assert.equal(tupleString(decodeTuple(DEPOSIT_EVENT), "action"), "deposit");
    assert.equal(tupleString(decodeTuple(DEPOSIT_EVENT), "caller"), null);
  });

  it("returns null for a value of another shape", () => {
    assert.equal(decodeUint(PAUSE_STATES), null);
    assert.deepEqual(decodeTuple(TOTAL_ASSETS), {});
  });
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Hiro client", () => {
  const block = {
    height: 9012515,
    hash: "0xaa",
    parent_block_hash: "0xa9",
    block_time_iso: "2026-09-17T19:53:52.000Z",
  };

  it("sends the API key and maps a block", async () => {
    let seenKey: string | null = null;
    const hiro = createHiro({
      apiBase: "https://api.example",
      apiKey: "secret",
      fetch: stubFetch((_url, init) => {
        seenKey = new Headers(init?.headers).get("x-api-key");
        return json({ results: [block] });
      }),
    });
    assert.deepEqual(await hiro.latestBlock(), {
      height: 9012515,
      hash: "0xaa",
      parentHash: "0xa9",
      blockTime: "2026-09-17T19:53:52.000Z",
    });
    assert.equal(seenKey, "secret");
  });

  it("classifies a rate limit and a provider failure", async () => {
    const limited = createHiro({ apiBase: "https://api.example", fetch: stubFetch(() => json({}, 429)) });
    await assert.rejects(limited.latestBlock(), (error: Error & { code?: string }) => error.code === "RATE_LIMITED");
    const broken = createHiro({ apiBase: "https://api.example", fetch: stubFetch(() => json({}, 500)) });
    await assert.rejects(broken.blockAt(1), (error: Error & { code?: string }) => error.code === "PROVIDER_TIMEOUT");
  });

  it("keeps only contract logs from the events page", async () => {
    const hiro = createHiro({
      apiBase: "https://api.example",
      fetch: stubFetch(() =>
        json({
          results: [
            { tx_id: "0x1", event_index: 2, contract_log: { contract_id: "SP1.vault", value: { hex: "0x01" } } },
            { tx_id: "0x1", event_index: 3 },
          ],
        }),
      ),
    });
    assert.deepEqual(await hiro.contractEvents("SP1.vault", 10), [
      { txId: "0x1", eventIndex: 2, payloadHex: "0x01", contractId: "SP1.vault" },
    ]);
  });

  it("fails a read that the node rejects", async () => {
    const hiro = createHiro({
      apiBase: "https://api.example",
      fetch: stubFetch(() => json({ okay: false, cause: "Unchecked(NoSuchContract)" })),
    });
    await assert.rejects(hiro.callRead("SP1.vault", "get-total-assets", [], "SP1"), (error: { message?: string }) =>
      (error.message ?? "").includes("NoSuchContract"),
    );
  });
});
