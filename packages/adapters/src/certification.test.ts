import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADAPTER_CERTIFICATION_FIXTURES, certifyBuiltinAdapters } from "./certificationFixtures.ts";
import { certifyAdapter } from "./certification.ts";

describe("K24 protocol adapter certification", () => {
  it("certifies every built-in fixture and emits auditable deployment metadata", () => {
    const reports = certifyBuiltinAdapters();
    assert.equal(reports.length, 5);
    assert.deepEqual(reports.map((report) => report.protocol).sort(), ["bitflow", "granite", "sbtc", "sbtc", "zest"]);
    for (const report of reports) {
      assert.equal(report.status, "fixture_conformant");
      assert.match(report.adapterVersion, /^[a-z0-9-]+@\d+\.\d+\.\d+$/);
      assert.ok(report.registryVersion.length > 0);
      assert.ok(report.deployment.includes("."));
      assert.ok(report.deploymentRevision.length > 0);
      assert.ok(report.blockHeight > 0);
      assert.ok(report.blockHash.length > 0);
      assert.ok(report.checks.includes("read fixture exact"));
      assert.ok(report.checks.includes("quote fixture exact"));
      assert.ok(report.checks.includes("plan fixture exact"));
      assert.ok(report.checks.includes("reconciliation mismatch fails closed"));
      assert.deepEqual(report.failures, []);
    }
  });

  it("rejects an inferred position field that is absent from the fixture contract", () => {
    const fixture = ADAPTER_CERTIFICATION_FIXTURES.find((item) => item.read.expected.value.length > 0);
    assert.ok(fixture !== undefined);
    const adapter = {
      ...fixture.adapter,
      readPositions(ctx: Parameters<typeof fixture.adapter.readPositions>[0], owner: string) {
        const point = fixture.adapter.readPositions(ctx, owner);
        assert.ok(point.value !== null);
        return { ...point, value: point.value.map((position) => ({ ...position, blockHeight: 123 })) };
      },
    };
    const report = certifyAdapter({ ...fixture, id: "reject-inferred-position", adapter });
    assert.equal(report.status, "failed");
    assert.ok(report.failures.some((failure) => failure.startsWith("read fixture exact:")));
  });

  it("rejects a post-condition amount changed by one base unit", () => {
    const fixture = ADAPTER_CERTIFICATION_FIXTURES.find((item) => item.id === "bitflow-swap-mainnet-v1");
    assert.ok(fixture !== undefined);
    const [step] = fixture.plan.steps;
    assert.ok(step?.payload.kind === "stacks_contract_call");
    const [send, receive] = step.payload.postConditions;
    assert.ok(send !== undefined && receive !== undefined);
    const report = certifyAdapter({
      ...fixture,
      id: "reject-post-condition-rounding",
      plan: {
        ...fixture.plan,
        steps: [
          {
            ...step,
            payload: {
              ...step.payload,
              postConditions: [send, { ...receive, amount: { ...receive.amount, quantity: "99002499999" } }],
            },
          },
        ],
      },
    });
    assert.equal(report.status, "failed");
    assert.ok(report.failures.some((failure) => failure.startsWith("plan fixture exact:")));
  });
});
