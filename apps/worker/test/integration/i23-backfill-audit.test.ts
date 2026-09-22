import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MIGRATIONS_DIR, type Sql, connect, migrate, readCheckpoint } from "@stacks-capital/database";
import { seedFixtures } from "@stacks-capital/database/fixtures";
import { auditProjections } from "../../src/audit.ts";
import type { Hiro } from "../../src/hiro.ts";
import { runBackfill } from "../../src/processes/backfill.ts";
import { ingestTick, reorgReplay } from "../../src/processes/ingest.ts";
import { observerTick } from "../../src/processes/observer.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc";
const DIA = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle";

const HEX = {
  total: "0x070100000000000000000000000f5fd643d9",
  available: "0x0100000000000000000000000daa6428a4",
  cap: "0x07010000000000000000000000746a528800",
  rate: "0x070100000000000000000000000000000082",
  pause:
    "0x070c00000006066163637275650406626f72726f7704076465706f7369740409666c6173686c6f616e040672656465656d0405726570617904",
  priceValid:
    "0x070c000000020974696d657374616d70010000000000000000000001a0b0e88ccf0576616c7565010000000000000000000006f65088415c",
  shares: "0x070100000000000000000000000005f5e100",
  assets: "0x070100000000000000000000000005f6b79a",
  points: "0x070b0000000201000000000000000000000000000000820100000000000000000000000000000082",
  updated: "0x07010000000000000000000000006aacee0c",
  event:
    "0x0c0000000306616374696f6e0d000000076465706f7369740663616c6c657206165423cdfe275d8bb19862b0cf342c616a7a18c8420b76302d382d6d61726b657404646174610c0000000506616d6f756e740100000000000000000000000000001962066173736574730100000000000000000000000f5fc768c8096465706f7369746f7206165423cdfe275d8bb19862b0cf342c616a7a18c8420b76302d382d6d61726b657409726563697069656e740516756f6730289f363631aa3c732974504560192bfa0d7368617265732d6d696e746564010000000000000000000000000000195e",
};

type FakeBlock = { height: number; hash: string; parentHash: string };
type FakeEvent = { txId: string; eventIndex: number; payloadHex: string; blockHeight: number; canonical: boolean };

function createFakeChain() {
  const state = {
    blocks: [] as FakeBlock[],
    events: new Map<string, FakeEvent[]>(),
  };

  const grow = (count: number, prefix = "b") => {
    for (let i = 0; i < count; i += 1) {
      const last = state.blocks.at(-1);
      const height = (last?.height ?? 99) + 1;
      state.blocks.push({ height, hash: `0x${prefix}${height}`, parentHash: last?.hash ?? "0xgenesis" });
    }
  };

  const hiro: Hiro = {
    async latestBlock() {
      const tip = state.blocks.at(-1);
      if (tip === undefined) throw new Error("empty chain");
      return { ...tip, blockTime: "2026-09-21T12:00:00.000Z" };
    },
    async blockAt(height: number) {
      const block = state.blocks.find((candidate) => candidate.height === height);
      if (block === undefined) throw new Error(`no block at ${height}`);
      return { ...block, blockTime: "2026-09-21T12:00:00.000Z" };
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
    async callRead(contractId: string, fn: string) {
      if (contractId === DIA) {
        // Return valid price tuple for all oracle feeds
        return HEX.priceValid;
      }
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

describe("Task I23: Registry backfill, continuous canonical history, and projection audit", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_i23_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let chain: ReturnType<typeof createFakeChain>;
  let baseHeight = 0;

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);

    const checkpoint = await readCheckpoint(sql, "stacks", "mainnet");
    assert.ok(checkpoint !== null, "Fixtures must seed stacks:mainnet checkpoint");
    baseHeight = checkpoint.height;

    chain = createFakeChain();
    chain.state.blocks = [{ height: baseHeight, hash: checkpoint.hash, parentHash: "0xseed_parent" }];
  });

  let simulatedTime = Date.now();
  const tickTime = (minutes = 5) => {
    simulatedTime += minutes * 60_000;
    return new Date(simulatedTime);
  };

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("Acceptance Evidence 1: Projection audit passes with every checkpoint complete", async () => {
    // 1. Initial audit before observer tick shows missing snapshots
    const initialReport = await auditProjections({
      sql,
      network: "mainnet",
      chain: "stacks",
    });

    assert.equal(initialReport.network, "mainnet");
    assert.equal(initialReport.chain, "stacks");
    assert.ok(initialReport.checkpoint !== null);
    assert.equal(initialReport.checkpoint?.height, baseHeight);
    assert.ok(initialReport.targetsAudited > 0);

    // 2. Run observer tick to generate fresh canonical snapshots and price feeds
    await observerTick({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at: tickTime(1),
    });

    // 3. Post-observer audit now passes completely with isHealthy: true
    const postReport = await auditProjections({
      sql,
      network: "mainnet",
      chain: "stacks",
    });

    assert.equal(postReport.isHealthy, true, `Audit must pass: ${postReport.auditErrors.join("; ")}`);
    assert.equal(postReport.missingTargets.length, 0);
    assert.equal(postReport.missingPriceFeeds.length, 0);
    assert.ok(postReport.priceFeedsAudited >= 3);
    assert.ok(postReport.allCheckpoints.length >= 1);
  });

  it("Acceptance Evidence 2: A new block advances projections without manual commands", async () => {
    const at = tickTime(2);

    // Add 2 new blocks to the chain
    chain.grow(2, "adv");
    const newTipHeight = baseHeight + 2;

    // Run continuous ingestion tick with advanceProjections: true
    const summary = await ingestTick({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at,
      advanceProjections: true,
    });

    assert.equal(summary.blocks, 2);
    assert.equal(summary.tipHeight, newTipHeight);
    assert.equal(summary.projectionsAdvanced, true);

    // Verify checkpoint advanced automatically
    const updatedCheckpoint = await readCheckpoint(sql, "stacks", "mainnet");
    assert.deepEqual(updatedCheckpoint, {
      height: newTipHeight,
      hash: `0xadv${newTipHeight}`,
    });

    // Verify canonical snapshots were written at the new block height without manual commands
    const [latestSnapshot] = await sql<{ blockHeight: number; blockHash: string; availableLiquidity: string }[]>`
      SELECT block_height::int AS "blockHeight", block_hash AS "blockHash",
             available_liquidity::text AS "availableLiquidity"
      FROM market_snapshots
      WHERE network = 'mainnet' AND market_id = 'zest.sbtc.vault'
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `;

    assert.equal(latestSnapshot?.blockHeight, newTipHeight);
    assert.equal(latestSnapshot?.blockHash, `0xadv${newTipHeight}`);
    assert.ok(BigInt(latestSnapshot?.availableLiquidity ?? "0") > 0n);
  });

  it("Acceptance Evidence 3: Reorg replay removes orphaned evidence and rebuilds affected state", async () => {
    const currentCheckpoint = await readCheckpoint(sql, "stacks", "mainnet");
    assert.ok(currentCheckpoint !== null);
    const commonAncestorHeight = currentCheckpoint.height;
    const commonAncestorHash = currentCheckpoint.hash;

    // 1. Grow fork A by 2 blocks and attach an event
    chain.grow(2, "forkA");
    const forkATip = commonAncestorHeight + 2;
    chain.state.events.set(VAULT, [
      {
        txId: "0xtx_fork_a",
        eventIndex: 1,
        payloadHex: HEX.event,
        blockHeight: forkATip,
        canonical: true,
      },
    ]);

    await ingestTick({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at: tickTime(2),
      advanceProjections: true,
    });

    // Verify fork A event was stored as canonical
    const [forkAActivity] = await sql<{ id: string; canonical: boolean }[]>`
      SELECT id, canonical FROM canonical_activities WHERE id = 'act_0xtx_fork_a:1'
    `;
    assert.equal(forkAActivity?.canonical, true);

    const [totalBlocksBefore] = await sql<{ count: string }[]>`SELECT count(*) AS count FROM chain_blocks`;
    const [totalEventsBefore] = await sql<{ count: string }[]>`SELECT count(*) AS count FROM raw_events`;

    // 2. Reorg: replace fork A with fork B from the common ancestor
    chain.state.blocks = chain.state.blocks.filter((b) => b.height <= commonAncestorHeight);
    chain.grow(2, "forkB");
    const forkBTip = commonAncestorHeight + 2;
    chain.state.events.set(VAULT, [
      {
        txId: "0xtx_fork_b",
        eventIndex: 1,
        payloadHex: HEX.event,
        blockHeight: forkBTip,
        canonical: true,
      },
    ]);

    // 3. Execute reorgReplay
    const replayResult = await reorgReplay({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      at: tickTime(2),
      advanceProjections: true,
    });

    // Assert reorg detection & rewind
    assert.equal(replayResult.ancestorHash, commonAncestorHash);
    assert.equal(replayResult.orphanedBlocks, 2);
    assert.equal(replayResult.orphanedActivities, 1);
    assert.equal(replayResult.rebuiltBlocks, 2);
    assert.equal(replayResult.newCheckpoint?.height, forkBTip);
    assert.equal(replayResult.newCheckpoint?.hash, `0xforkB${forkBTip}`);

    // Assert orphaned evidence is NOT deleted, only marked noncanonical
    const [forkAAfter] = await sql<{ canonical: boolean }[]>`
      SELECT canonical FROM canonical_activities WHERE id = 'act_0xtx_fork_a:1'
    `;
    assert.equal(forkAAfter?.canonical, false, "Orphaned activity must be marked noncanonical");

    const [orphanedBlocksCount] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM chain_blocks WHERE NOT canonical
    `;
    assert.ok(Number(orphanedBlocksCount?.count) >= 2, "Orphaned blocks must be preserved with canonical = false");

    // Total rows increased (no deletions occurred)
    const [totalBlocksAfter] = await sql<{ count: string }[]>`SELECT count(*) AS count FROM chain_blocks`;
    const [totalEventsAfter] = await sql<{ count: string }[]>`SELECT count(*) AS count FROM raw_events`;
    assert.ok(Number(totalBlocksAfter?.count) > Number(totalBlocksBefore?.count));
    assert.ok(Number(totalEventsAfter?.count) > Number(totalEventsBefore?.count));

    // Assert new fork B event is canonical
    const [forkBActivity] = await sql<{ canonical: boolean }[]>`
      SELECT canonical FROM canonical_activities WHERE id = 'act_0xtx_fork_b:1'
    `;
    assert.equal(forkBActivity?.canonical, true, "Replacement fork activity must be canonical");

    // Assert projections were rebuilt cleanly for the new canonical block
    const auditAfterReorg = await auditProjections({
      sql,
      network: "mainnet",
      chain: "stacks",
    });
    assert.equal(auditAfterReorg.isHealthy, true);
    assert.equal(auditAfterReorg.checkpoint?.height, forkBTip);
    assert.equal(auditAfterReorg.checkpoint?.hash, `0xforkB${forkBTip}`);
  });

  it("Backfill operates with automatic reproject and projection audit", async () => {
    const tip = chain.state.blocks.at(-1);
    assert.ok(tip !== undefined);

    const backfillResult = await runBackfill({
      sql,
      hiro: chain.hiro,
      network: "mainnet",
      toHeight: tip.height,
      reproject: true,
      audit: true,
    });

    assert.equal(backfillResult.status, "completed");
    assert.equal(backfillResult.toHeight, tip.height);
    assert.ok(backfillResult.auditReport !== undefined);
    assert.equal(backfillResult.auditReport.isHealthy, true);
    assert.equal(backfillResult.auditReport.missingTargets.length, 0);
  });
});
