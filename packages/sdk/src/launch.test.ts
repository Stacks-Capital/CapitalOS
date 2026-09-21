import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPABILITIES } from "@stacks-capital/config";
import { executable } from "./client.ts";
import { LAUNCH_DECISION, launchRow } from "./surface.ts";

describe("K20 launch decision", () => {
  it("does not launch production and does not certify webhooks", () => {
    assert.equal(LAUNCH_DECISION.production, "no-go");
    assert.equal(LAUNCH_DECISION.sandboxCertification, "go");
    assert.equal(LAUNCH_DECISION.closedEarnPilot, "no-go");
    assert.equal(LAUNCH_DECISION.webhooks, "not-certified");
    assert.equal(LAUNCH_DECISION.schemaVersion, "1.0");
  });

  it("covers every registry capability and never certifies a disabled action", () => {
    assert.equal(LAUNCH_DECISION.rows.length, CAPABILITIES.length);
    for (const capability of CAPABILITIES) {
      const row = launchRow(capability.action, capability.network, capability.protocol);
      assert.ok(row !== undefined, `${capability.protocol}/${capability.action} ${capability.network} is missing`);
      if (capability.state === "disabled") assert.equal(row.certification, "disabled");
      if (row.certification === "sandbox") assert.equal(capability.state, "enabled");
      if (row.certification === "disabled") {
        assert.equal(executable(capability.action, capability.network, capability.protocol), false);
      }
    }
  });

  it("certifies only mainnet Zest supply for the partner sandbox path", () => {
    const certified = LAUNCH_DECISION.rows.filter((row) => row.certification === "sandbox");
    assert.deepEqual(
      certified.map((row) => `${row.protocol}.${row.action}.${row.network}`),
      ["zest.supply.mainnet"],
    );
    assert.equal(executable("supply", "mainnet", "zest"), true);
    assert.equal(executable("stake", "mainnet"), false);
    assert.equal(executable("stake", "testnet"), false);
    assert.equal(executable("swap", "testnet", "bitflow"), false);
  });

  it("records K40 ownership, rollback triggers and go-live requirements", () => {
    assert.equal(LAUNCH_DECISION.ownership.productOwner, "Kenzman");
    assert.equal(LAUNCH_DECISION.ownership.incidentOwner, "IBK");
    assert.equal(LAUNCH_DECISION.ownership.supportOwner, "Kenzman");
    assert.equal(LAUNCH_DECISION.ownership.reviewer, "IBK");
    assert.ok(LAUNCH_DECISION.rollbackTriggers.some((row) => /SEV-0/.test(row)));
    assert.ok(LAUNCH_DECISION.goLiveRequirements.some((row) => /P0/.test(row)));
    assert.deepEqual([...LAUNCH_DECISION.p0Gates], ["K38", "K39", "K40"]);
    assert.equal(LAUNCH_DECISION.production, "no-go");
    assert.equal(LAUNCH_DECISION.closedEarnPilot, "no-go");
  });
});
