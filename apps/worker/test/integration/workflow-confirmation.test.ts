import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  connect,
  findWorkflowByTxid,
  listWorkflowsAwaitingConfirmation,
  MIGRATIONS_DIR,
  migrate,
  type Sql,
} from "@stacks-capital/database";
import { seedFixtures } from "@stacks-capital/database/fixtures";
import { advanceSubmittedWorkflows } from "../../src/confirmations.ts";
import type { Hiro, HiroTransaction } from "../../src/hiro.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

/*
 * Pilot blocker B1. A workflow reached SUBMITTED and stayed there, because nothing read a
 * transaction id back to the workflow that broadcast it. The fixtures hid it: they seed a workflow
 * directly into CONFIRMING with the evidence "Transaction seen in a block", a state no production
 * code path could reach. These tests build their own workflows and drive the real SQL.
 *
 * Each test gets a fresh workflow because state_transitions is append only, enforced by a trigger,
 * so a workflow cannot be rewound once it has moved.
 */

type TxAnswer = HiroTransaction | Error;

function hiroReturning(answer: TxAnswer): Hiro {
  return {
    async transaction(): Promise<HiroTransaction> {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as Hiro;
}

describe("moving a submitted workflow on chain evidence", {
  skip: DATABASE_URL === "" ? "DATABASE_URL is not set" : false,
}, () => {
  const admin = connect(DATABASE_URL);
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  let quoteId = "";
  let planId = "";
  let blockHeight = 0;
  let blockHash = "";
  const at = new Date(Date.UTC(2026, 8, 22, 12, 0, 0));

  before(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = connect(DATABASE_URL, schema);
    await migrate(sql, MIGRATIONS_DIR);
    await seedFixtures(sql);

    const [seeded] = await sql<{ quoteId: string; planId: string }[]>`
        SELECT quote_id AS "quoteId", plan_id AS "planId" FROM workflows LIMIT 1
      `;
    assert.ok(seeded, "the fixtures should seed a workflow to borrow a quote and plan from");
    quoteId = seeded.quoteId;
    planId = seeded.planId;

    const [checkpoint] = await sql<{ height: number }[]>`
        SELECT height::int FROM ingestion_checkpoints WHERE chain = 'stacks' AND network = 'mainnet'
      `;
    assert.ok(checkpoint, "the fixtures should seed a checkpoint");
    // One block below the checkpoint, so ingestion has stored a block above the transaction.
    blockHeight = checkpoint.height - 1;

    const [block] = await sql<{ hash: string }[]>`
        SELECT hash FROM chain_blocks
        WHERE chain = 'stacks' AND network = 'mainnet' AND height = ${blockHeight} AND canonical
      `;
    assert.ok(block, `the fixtures should seed a canonical block at ${blockHeight}`);
    blockHash = block.hash;
  });

  after(async () => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  /** A workflow in exactly the state the API leaves behind: SUBMITTED, with the broadcast recorded. */
  async function submittedWorkflow(steps = 1): Promise<{ id: string; txid: string }> {
    const id = `wf_${randomBytes(6).toString("hex")}`;
    const txid = `0x${randomBytes(32).toString("hex")}`;

    await sql`
        INSERT INTO workflows (id, network, idempotency_key, app_id, owner_address, quote_id, plan_id,
                               state, next_action, created_at, updated_at)
        VALUES (${id}, 'mainnet', ${`idem_${id}`}, 'app_fixture',
                (SELECT owner_address FROM workflows WHERE quote_id = ${quoteId} LIMIT 1),
                ${quoteId}, ${planId}, 'SUBMITTED', 'WAIT', ${at}, ${at})
      `;
    for (let ordinal = 0; ordinal < steps; ordinal += 1) {
      await sql`
          INSERT INTO workflow_steps (id, workflow_id, ordinal, kind, depends_on)
          VALUES (${`${id}:s${ordinal}`}, ${id}, ${ordinal}, 'stacks_contract_call', '{}')
        `;
    }
    await sql`
        INSERT INTO transaction_attempts (workflow_id, step_id, chain, network, outcome, txid, evidence, recorded_at)
        VALUES (${id}, ${`${id}:s0`}, 'stacks', 'mainnet', 'BROADCAST', ${txid}, 'wallet response with txid', ${at})
      `;
    const moves = [
      ["DRAFT", "QUOTED"],
      ["QUOTED", "AWAITING_SIGNATURE"],
      ["AWAITING_SIGNATURE", "SUBMITTED"],
    ] as const;
    for (const [index, [from, to]] of moves.entries()) {
      await sql`
          INSERT INTO state_transitions (workflow_id, sequence, from_state, to_state, reason, actor, evidence, at)
          VALUES (${id}, ${index + 1}, ${from}, ${to}, 'test setup', 'test', 'test', ${at})
        `;
    }
    return { id, txid };
  }

  const stateOf = async (id: string) => {
    const [row] = await sql<{ state: string; nextAction: string }[]>`
        SELECT state, next_action AS "nextAction" FROM workflows WHERE id = ${id}
      `;
    return row;
  };

  const movesOf = async (id: string) => {
    const rows = await sql<{ from: string; to: string }[]>`
        SELECT from_state AS "from", to_state AS "to" FROM state_transitions
        WHERE workflow_id = ${id} ORDER BY sequence
      `;
    return rows.map((row) => `${row.from}->${row.to}`);
  };

  const run = (answer: TxAnswer, checkpointHeight: number | null = blockHeight + 1) =>
    advanceSubmittedWorkflows({
      sql,
      hiro: hiroReturning(answer),
      network: "mainnet",
      at,
      checkpointHeight,
    });

  const confirmed = (): HiroTransaction => ({ status: "success", canonical: true, blockHeight, blockHash });

  it("finds a submitted workflow by the transaction it broadcast", async () => {
    const { id, txid } = await submittedWorkflow();

    const pending = await listWorkflowsAwaitingConfirmation(sql, { network: "mainnet", limit: 50 });
    const row = pending.find((candidate) => candidate.workflowId === id);

    assert.ok(row, "a submitted workflow with a broadcast txid should be listed");
    assert.equal(row.txid, txid);
    assert.equal(row.state, "SUBMITTED");
    assert.equal(row.isFinalStep, true);
  });

  it("walks it to STEP_CONFIRMED and records every state on the way", async () => {
    const { id } = await submittedWorkflow();

    await run(confirmed());

    assert.equal((await stateOf(id))?.state, "STEP_CONFIRMED");
    assert.deepEqual((await movesOf(id)).slice(-2), ["SUBMITTED->CONFIRMING", "CONFIRMING->STEP_CONFIRMED"]);
  });

  it("is idempotent: a second pass over a confirmed workflow changes nothing", async () => {
    const { id } = await submittedWorkflow();
    await run(confirmed());
    const before = await movesOf(id);

    await run(confirmed());

    assert.deepEqual(await movesOf(id), before);
    assert.equal((await stateOf(id))?.state, "STEP_CONFIRMED");
  });

  it("stops at CONFIRMING while ingestion has not stored a block above the transaction", async () => {
    const { id } = await submittedWorkflow();

    await run(confirmed(), blockHeight);

    assert.equal((await stateOf(id))?.state, "CONFIRMING");
    assert.equal((await movesOf(id)).at(-1), "SUBMITTED->CONFIRMING");
  });

  it("carries a multi-step plan back to a signable state", async () => {
    const { id } = await submittedWorkflow(2);

    await run(confirmed());

    const state = await stateOf(id);
    assert.equal(state?.state, "AWAITING_SIGNATURE");
    assert.equal(state?.nextAction, "SIGN");
  });

  it("leaves a mempool transaction submitted", async () => {
    const { id } = await submittedWorkflow();

    await run({ status: "pending", canonical: false, blockHeight: null, blockHash: null });

    assert.equal((await stateOf(id))?.state, "SUBMITTED");
  });

  it("leaves the workflow alone when the provider cannot be read", async () => {
    const { id } = await submittedWorkflow();

    const summary = await run(new Error("provider timeout"));

    assert.ok(summary.unreadable >= 1);
    assert.equal((await stateOf(id))?.state, "SUBMITTED");
  });

  it("fails the workflow when the transaction reverted, instead of confirming it", async () => {
    const { id } = await submittedWorkflow();

    await run({ ...confirmed(), status: "abort_by_post_condition" });

    const state = await stateOf(id);
    assert.equal(state?.state, "FAILED");
    assert.equal(state?.nextAction, "START_NEW");
  });

  it("reorgs the workflow when its block is not the canonical one at that height", async () => {
    const { id } = await submittedWorkflow();

    await run({ ...confirmed(), blockHash: "0xsomeotherblock" });

    assert.equal((await stateOf(id))?.state, "REORGED");
  });

  it("never reaches COMPLETED on chain evidence alone", async () => {
    const { id } = await submittedWorkflow();

    await run(confirmed());

    assert.notEqual((await stateOf(id))?.state, "COMPLETED");
  });

  it("links an observed transaction back to the workflow that broadcast it", async () => {
    const { id, txid } = await submittedWorkflow();

    const origin = await findWorkflowByTxid(sql, { network: "mainnet", txid });

    assert.equal(origin?.workflowId, id);
    assert.equal(origin?.stepId, "s0");
  });

  it("does not attribute a transaction nobody broadcast", async () => {
    assert.equal(await findWorkflowByTxid(sql, { network: "mainnet", txid: "0xnotours" }), null);
  });
});
