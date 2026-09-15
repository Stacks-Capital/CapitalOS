import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identifyBitcoinNetwork } from "./lib.ts";
import { PYTH_BTC_USD_FEED, TARGETS } from "./targets.ts";

const live = process.env.PROBE_LIVE === "1";
const BITCOIN_REGTEST_MAGIC = 0xdab5bffa;

function get(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(30_000) });
}

describe("live provider behavior", { skip: live ? false : "set PROBE_LIVE=1 to call real providers" }, () => {
  it("Hiro reports ready on both networks", async () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const body = (await (await get(`${TARGETS[network].stacksApi}/extended`)).json()) as { status: string };
      assert.equal(body.status, "ready", network);
    }
  });

  it("Hiro rejects page sizes above 50", async () => {
    const res = await get(`${TARGETS.mainnet.stacksApi}/extended/v1/tx?limit=51`);
    assert.equal(res.status, 400);
  });

  it("Stacks testnet is anchored to Bitcoin regtest", async () => {
    const info = (await (await get(`${TARGETS.testnet.stacksApi}/v2/info`)).json()) as { parent_network_id: number };
    assert.equal(info.parent_network_id, BITCOIN_REGTEST_MAGIC);

    const regtest = TARGETS.testnet.bitcoinApis.find((api) => api.name === "Hiro regtest mempool");
    assert.ok(regtest);
    const genesis = await (await get(`${regtest.base}/block-height/0`)).text();
    assert.equal(identifyBitcoinNetwork(genesis), "regtest");
  });

  it("Pyth Hermes rejects price requests without an API key", async () => {
    const res = await get(`${TARGETS.mainnet.hermes}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD_FEED}`);
    assert.equal(res.status, 401);
  });

  it("Emily pages deposits with nextToken", async () => {
    const body = (await (await get(`${TARGETS.mainnet.emily}/deposit?status=confirmed&pageSize=1`)).json()) as object;
    assert.ok("nextToken" in body);
  });
});
