import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowsWriteRetry, capitalError } from "./errors.ts";
import { sip10 } from "./ids.ts";
import { amount as makeAmount } from "./amounts.ts";
import type { Plan } from "./plan.ts";
import type { Quote } from "./quote.ts";
import { validatePlan, type SigningContext } from "./signing.ts";
import {
  applyReorgToWorkflow,
  canSubmitWrite,
  createWorkflow,
  recordUnknownBroadcast,
  transition,
} from "./workflow.ts";

const sbtc = sip10("mainnet", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", "sbtc-token");
const now = new Date("2026-09-15T12:00:00.000Z");

function quote(): Quote {
  return {
    id: "q1",
    action: "supply",
    marketId: "zest.sbtc.vault",
    network: "mainnet",
    input: [makeAmount(sbtc, "1000")],
    expectedOutput: [makeAmount(sbtc, "1000")],
    fees: [],
    snapshots: [],
    expiresAt: "2026-09-15T12:10:00.000Z",
    executable: true,
    warnings: [],
    registryVersion: "0.1.0",
    adapterVersion: "zest-earn@0.1.0",
    minimumOutput: makeAmount(sbtc, "1000"),
  };
}

function plan(): Plan {
  return {
    id: "p1",
    quoteId: "q1",
    network: "mainnet",
    registryVersion: "0.1.0",
    adapterVersion: "zest-earn@0.1.0",
    expiresAt: "2026-09-15T12:10:00.000Z",
    reviewSummary: "supply",
    steps: [
      {
        id: "deposit",
        dependsOn: [],
        expectedAssetEffects: [makeAmount(sbtc, "1000")],
        payload: {
          kind: "stacks_contract_call",
          contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
          functionName: "deposit",
          functionArgs: [{ type: "uint", value: "1000" }],
          postConditions: [
            {
              principal: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
              mode: "send_lte",
              amount: makeAmount(sbtc, "1000"),
            },
          ],
          postConditionMode: "deny",
          network: "mainnet",
        },
      },
    ],
  };
}

const ctx: SigningContext = {
  now,
  network: "mainnet",
  registryVersion: "0.1.0",
  sender: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
};

describe("K17 transaction threat controls", () => {
  it("rejects a substituted plan that is not bound to the quote", () => {
    const swapped = { ...plan(), quoteId: "q-other" };
    const checked = validatePlan(swapped, quote(), ctx);
    assert.equal(checked.ok, false);
    assert.match(checked.reasons.join(" "), /not bound/);
  });

  it("rejects network and registry confusion before a wallet sees the plan", () => {
    assert.equal(validatePlan(plan(), quote(), { ...ctx, network: "testnet" }).ok, false);
    assert.equal(validatePlan(plan(), quote(), { ...ctx, registryVersion: "9.9.9" }).ok, false);
    assert.equal(
      validatePlan(plan(), quote(), { ...ctx, sender: "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0" }).ok,
      false,
    );
  });

  it("never retries a write after an unknown broadcast", () => {
    let flow = createWorkflow({ id: "wf_dup", network: "mainnet", idempotencyKey: "dup" });
    flow = transition(flow, "QUOTED", { reason: "q", actor: "sdk", evidence: "q" });
    flow = transition(flow, "AWAITING_SIGNATURE", { reason: "p", actor: "sdk", evidence: "p" });
    flow = recordUnknownBroadcast(flow, "empty txid");
    assert.equal(canSubmitWrite(flow.state), false);
    assert.equal(allowsWriteRetry(capitalError("BROADCAST_UNKNOWN", "empty txid")), false);
    assert.equal(allowsWriteRetry(capitalError("REORG_DETECTED", "rewound")), false);
  });

  it("keeps a completed workflow inspectable after a reorg instead of deleting it", () => {
    let flow = createWorkflow({ id: "wf_reorg", network: "mainnet", idempotencyKey: "r" });
    for (const state of [
      "QUOTED",
      "AWAITING_SIGNATURE",
      "SUBMITTED",
      "CONFIRMING",
      "STEP_CONFIRMED",
      "RECONCILING",
      "COMPLETED",
    ] as const) {
      flow = transition(flow, state, { reason: state, actor: "test", evidence: state });
    }
    flow = applyReorgToWorkflow(flow, "parent-hash");
    assert.equal(flow.state, "REORGED");
    assert.equal(flow.nextAction, "CONTACT_SUPPORT");
  });
});
