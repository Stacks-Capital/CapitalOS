import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  MIGRATIONS_DIR,
  type Sql,
  connect,
  migrate,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@stacks-capital/database";
import { seedFixtures } from "@stacks-capital/database/fixtures";
import type { Hiro } from "../../src/hiro.ts";
import { runBackfill } from "../../src/processes/backfill.ts";
import { ingestTick } from "../../src/processes/ingest.ts";
import { observerTick } from "../../src/processes/observer.ts";
import { reconcileTick } from "../../src/processes/reconcile.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc";
const DIA = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle";
const FEEDS = ["BTC/USD", "USDC/USD"];

const HEX = {
  total: "0x070100000000000000000000000f5fd643d9",
  available: "0x0100000000000000000000000daa6428a4",
  cap: "0x07010000000000000000000000746a528800",
  rate: "0x070100000000000000000000000000000082",
  pause:
    "0x070c00000006066163637275650406626f72726f7704076465706f7369740409666c6173686c6f616e040672656465656d0405726570617904",
  btc: "0x070c000000020974696d657374616d70010000000000000000000001a0b0e88ccf0576616c7565010000000000000000000006f65088415c",
  zero: "0x070c000000020974696d657374616d7001000000000000000000000000000000000576616c75650100000000000000000000000000000000",
  shares: "0x070100000000000000000000000005f5e100",
  assets: "0x070100000000000000000000000005f6b79a",
  points: "0x070b0000000201000000000000000000000000000000820100000000000000000000000000000082",
  updated: "0x07010000000000000000000000006aacee0c",
  event:
    "0x0c0000000306616374696f6e0d000000076465706f7369740663616c6c657206165423cdfe275d8bb19862b0cf342c616a7a18c8420b76302d382d6d61726b657404646174610c0000000506616d6f756e740100000000000000000000000000001962066173736574730100000000000000000000000f5fc768c8096465706f7369746f7206165423cdfe275d8bb19862b0cf342c616a7a18c8420b76302d382d6d61726b657409726563697069656e740516756f6730289f363631aa3c732974504560192bfa0d7368617265732d6d696e746564010000000000000000000000000000195e",
};

type FakeBlock = { height: number; hash: string; parentHash: string };
type FakeEvent = { txId: string; eventIndex: number; payloadHex: string; blockHeight: number; canonical: boolean };

function fakeChain() {
  const state = {
    blocks: [] as FakeBlock[],
    events: new Map<string, FakeEvent[]>(),
  };

  const grow = (count: number, prefix = "b") => {
    for (let index = 0; index < count; index += 1) {
      const last = state.blocks.at(-1);
      const height = (last?.height ?? 99) + 1;
      state.blocks.push({ height, hash: `0x${prefix}${height}`, parentHash: last?.hash ?? "0xgenesis" });
    }
  };

  const hiro: Hiro = {
    async latestBlock() {
      const tip = state.blocks.at(-1);
      if (tip === undefined) throw new Error("empty chain");
      return { ...tip, blockTime: "2026-09-17T12:00:00.000Z" };
    },
    async blockAt(height: number) {
      const block = state.blocks.find((candidate) => candidate.height === height);
      if (block === undefined) throw new Error(`no block at ${height}`);
      return { ...block, blockTime: "2026-09-17T12:00:00.000Z" };
    },
    async contractEvents(contractId: string) {
      return (state.events.get(contractId) ?? []).map((event) => ({
        txId: event.txId,
        eventIndex: event.eventIndex,
        payloadHex: event.payloadHex,
        contractId,
      }));
    },
    async transaction(txId: string) {
      for (const events of state.events.values()) {
        const event = events.find((candidate) => candidate.txId === txId);
        if (event === undefined) continue;
        const block = state.blocks.find((candidate) => candidate.height === event.blockHeight);
        if (block === undefined) throw new Error(`no block for ${txId}`);
        return { blockHeight: block.height, blockHash: block.hash, canonical: event.canonical };
      }
      throw new Error(`no transaction ${txId}`);
    },
    async callRead(contractId: string, fn: string, args: string[]) {
      if (contractId === DIA) return args[0]?.includes("425443") === true ? HEX.btc : HEX.zero;
      if (contractId !== VAULT) throw new Error(`no read for ${contractId}`);
      const byFunction: Record<string, string> = {
        "get-balance": HEX.shares,
        "convert-to-assets": HEX.assets,
        "get-points-rate": HEX.points,
        "get-last-update": HEX.updated,
        "get-total-assets": HEX.total,
        "get-available-assets": HEX.available,
        "get-cap-supply": HEX.cap,
        "get-interest-rate": HEX.rate,
        "get-pause-states": HEX.pause,
      };
      const hex = byFunction[fn];
      if (hex === undefined) throw new Error(`no read for ${fn}`);
      return hex;
    },
  };

  return { state, grow, hiro };
}

describe("worker restart idempotency and topology", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_idemp_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let chain: ReturnType<typeof fakeChain>;
  let baseHeight = 0;

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);

    const [checkpoint] = await sql<{ height: number; hash: string }[]>`
      SELECT height::int, hash FROM ingestion_checkpoints WHERE chain = 'stacks' AND network = 'mainnet'
    `;
    assert.ok(checkpoint !== undefined);
    baseHeight = checkpoint.height;

    chain = fakeChain();
    chain.state.blocks = [{ height: baseHeight, hash: checkpoint.hash, parentHash: "0xseeded" }];
    chain.grow(3); // blocks baseHeight+1, baseHeight+2, baseHeight+3

    // Add contract event at block baseHeight+1
    chain.state.events.set(VAULT, [
      {
        txId: "0xevt1",
        eventIndex: 0,
        payloadHex: HEX.event,
        blockHeight: baseHeight + 1,
        canonical: true,
      },
    ]);
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const count = async (table: string, where = "true") => {
    const [row] = await sql.unsafe<{ count: string }[]>(`SELECT count(*) AS count FROM ${table} WHERE ${where}`);
    return Number(row?.count);
  };

  it("enforces session advisory locks across concurrent workers", async () => {
    // Acquire lock on main connection
    const firstLock = await tryAcquireWorkerLock(sql, "ingest", "mainnet");
    assert.equal(firstLock, true, "First lock acquisition should succeed");

    // Second lock on same session/connection
    // In PostgreSQL pg_try_advisory_lock on the same session increments lock depth and returns true.
    // However, on a second distinct connection, it must return false!
    const otherSql = connect(DATABASE_URL, schema);
    try {
      const secondLock = await tryAcquireWorkerLock(otherSql, "ingest", "mainnet");
      assert.equal(secondLock, false, "Second connection cannot acquire the same worker lock");

      // Different process name on other connection should succeed
      const diffProcessLock = await tryAcquireWorkerLock(otherSql, "observer", "mainnet");
      assert.equal(diffProcessLock, true, "Different process lock should succeed");
      await releaseWorkerLock(otherSql, "observer", "mainnet");
    } finally {
      await otherSql.end();
    }

    // Release main lock
    const released = await releaseWorkerLock(sql, "ingest", "mainnet");
    assert.equal(released, true, "Releasing worker lock should return true");
  });

  it("ingests blocks and events on first run, recording evidence and activities", async () => {
    const initialBlocks = await count("chain_blocks");
    const initialEvents = await count("raw_events");
    const initialActivities = await count("canonical_activities");

    const at = new Date(Date.UTC(2026, 8, 21, 10, 0, 0));
    const summary = await ingestTick({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at,
      maxBlocks: 10,
    });

    assert.equal(summary.blocks, 3);
    assert.equal(summary.events, 1);
    assert.equal(summary.activities, 1);

    const blocksCount = await count("chain_blocks");
    const eventsCount = await count("raw_events");
    const activitiesCount = await count("canonical_activities");

    assert.equal(blocksCount, initialBlocks + 3, "Exactly 3 new blocks stored");
    assert.equal(eventsCount, initialEvents + 1, "Exactly one new raw event stored");
    assert.equal(activitiesCount, initialActivities + 1, "Exactly one new activity stored");
  });

  it("re-running ingestion across the same block/event range produces 0 duplicates (restart idempotency)", async () => {
    const blocksBefore = await count("chain_blocks");
    const eventsBefore = await count("raw_events");
    const activitiesBefore = await count("canonical_activities");

    // Simulate worker restart: process restarts and executes tick again at the same chain state
    const at = new Date(Date.UTC(2026, 8, 21, 10, 5, 0));
    const restartSummary = await ingestTick({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at,
      maxBlocks: 10,
    });

    // Checkpoint was already at tip, so 0 new blocks and 0 new events ingested
    assert.equal(restartSummary.blocks, 0);
    assert.equal(restartSummary.events, 0);
    assert.equal(restartSummary.activities, 0);

    const blocksAfter = await count("chain_blocks");
    const eventsAfter = await count("raw_events");
    const activitiesAfter = await count("canonical_activities");

    assert.equal(blocksAfter, blocksBefore, "Blocks count must remain identical after restart");
    assert.equal(eventsAfter, eventsBefore, "Events count must remain identical (no duplicate events)");
    assert.equal(activitiesAfter, activitiesBefore, "Activities count must remain identical (no duplicate activities)");
  });

  it("one-shot backfill runs bounded range and terminates cleanly without duplicate records", async () => {
    const blocksBefore = await count("chain_blocks");
    const eventsBefore = await count("raw_events");

    // Run backfill over the already-ingested range (from baseHeight to baseHeight+3)
    const result = await runBackfill({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      fromHeight: baseHeight,
      toHeight: baseHeight + 3,
      maxBlocksPerBatch: 2,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.fromHeight, baseHeight);
    assert.equal(result.toHeight, baseHeight + 3);

    const blocksAfter = await count("chain_blocks");
    const eventsAfter = await count("raw_events");

    assert.equal(blocksAfter, blocksBefore, "Backfill must not duplicate blocks");
    assert.equal(eventsAfter, eventsBefore, "Backfill must not duplicate events");
  });

  it("observer and reconcile processes execute cleanly in isolated steps", async () => {
    const at = new Date(Date.UTC(2026, 8, 21, 10, 10, 0));

    // Observer tick
    const obsSummary = await observerTick({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at,
      priceFeeds: FEEDS,
    });

    assert.ok(obsSummary.markets.written > 0, "Observer should write market snapshots");
    assert.ok(obsSummary.prices.written > 0, "Observer should write price snapshots");

    // Reconcile tick
    const recSummary = await reconcileTick({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at,
    });

    assert.ok(recSummary.targetsChecked > 0, "Reconcile should check projection targets");
    assert.ok(
      recSummary.reconciliation.match + recSummary.reconciliation.mismatch + recSummary.reconciliation.unavailable > 0,
    );
  });
});
