import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricsSnapshot } from "@stacks-capital/database";
import { DEFAULT_THRESHOLDS, evaluateAlerts } from "./alerts.ts";

const AT = new Date("2026-09-18T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(AT.getTime() - minutes * 60_000);

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    network: "mainnet",
    at: AT,
    ingestion: {
      checkpointHeight: 9012515,
      checkpointAt: minutesAgo(1),
      blocksBehind: 2,
      lastTickAt: minutesAgo(1),
      failuresInWindow: 0,
    },
    quotes: [],
    stuck: [],
    ...overrides,
  };
}

const keys = (alerts: ReturnType<typeof evaluateAlerts>) => alerts.map((alert) => [alert.dedupeKey, alert.severity]);

describe("a healthy system", () => {
  it("raises nothing", () => {
    assert.deepEqual(evaluateAlerts(snapshot()), []);
  });
});

describe("ingestion", () => {
  it("warns when behind, and goes critical when far behind", () => {
    const warning = evaluateAlerts(snapshot({ ingestion: { ...snapshot().ingestion, blocksBehind: 40 } }));
    assert.deepEqual(keys(warning), [["ingestion_lag:mainnet", "warning"]]);
    assert.match(warning[0]?.message ?? "", /40 blocks behind/);

    const critical = evaluateAlerts(snapshot({ ingestion: { ...snapshot().ingestion, blocksBehind: 500 } }));
    assert.deepEqual(keys(critical), [["ingestion_lag:mainnet", "critical"]]);
  });

  it("treats a checkpoint that stopped moving as failing, even with no lag reading", () => {
    const alerts = evaluateAlerts(
      snapshot({ ingestion: { ...snapshot().ingestion, blocksBehind: null, checkpointAt: minutesAgo(25) } }),
    );
    assert.deepEqual(keys(alerts), [["ingestion_failing:mainnet", "critical"]]);
    assert.match(alerts[0]?.message ?? "", /not moved for 25 minutes/);
  });

  it("treats repeated tick failures as failing", () => {
    const alerts = evaluateAlerts(snapshot({ ingestion: { ...snapshot().ingestion, failuresInWindow: 3 } }));
    assert.deepEqual(keys(alerts), [["ingestion_failing:mainnet", "critical"]]);
  });
});

describe("quote failures", () => {
  it("waits for enough attempts before judging a rate", () => {
    const alerts = evaluateAlerts(
      snapshot({ quotes: [{ subject: "zest.sbtc.vault", attempts: 3, failures: 3, codes: { ORACLE_STALE: 3 } }] }),
    );
    assert.deepEqual(alerts, []);
  });

  it("raises one alert per market, with the codes that caused it", () => {
    const alerts = evaluateAlerts(
      snapshot({
        quotes: [
          { subject: "zest.sbtc.vault", attempts: 10, failures: 3, codes: { ORACLE_STALE: 2, PROVIDER_TIMEOUT: 1 } },
          { subject: "granite.sbtc.isolated", attempts: 10, failures: 8, codes: { CAPABILITY_DISABLED: 8 } },
          { subject: "bitflow.sbtc-usdcx", attempts: 10, failures: 1, codes: { RATE_LIMITED: 1 } },
        ],
      }),
    );
    assert.deepEqual(keys(alerts), [
      ["quote_failures:mainnet:zest.sbtc.vault", "warning"],
      ["quote_failures:mainnet:granite.sbtc.isolated", "critical"],
    ]);
    assert.match(alerts[0]?.message ?? "", /3 of 10 quotes failed.*ORACLE_STALE 2, PROVIDER_TIMEOUT 1/);
  });
});

describe("stuck workflows", () => {
  it("raises one alert per workflow, critical when only a person can fix it", () => {
    const alerts = evaluateAlerts(
      snapshot({
        stuck: [
          { id: "wf_1", state: "AWAITING_SIGNATURE", nextAction: "SIGN", updatedAt: minutesAgo(45), ageSeconds: 2700 },
          {
            id: "wf_2",
            state: "BROADCAST_UNKNOWN",
            nextAction: "CONTACT_SUPPORT",
            updatedAt: minutesAgo(1),
            ageSeconds: 60,
          },
        ],
      }),
    );
    assert.deepEqual(keys(alerts), [
      ["workflow_stuck:mainnet:wf_1", "warning"],
      ["workflow_stuck:mainnet:wf_2", "critical"],
    ]);
    assert.match(alerts[0]?.message ?? "", /AWAITING_SIGNATURE for 45 minutes/);
  });
});

describe("dedupe keys", () => {
  it("name the problem rather than the moment, so a repeat maps to the same alert", () => {
    const first = evaluateAlerts(snapshot({ ingestion: { ...snapshot().ingestion, blocksBehind: 40 } }));
    const later = evaluateAlerts(
      snapshot({ at: minutesAgo(-5), ingestion: { ...snapshot().ingestion, blocksBehind: 60 } }),
    );
    assert.equal(first[0]?.dedupeKey, later[0]?.dedupeKey);
  });

  it("keep the networks apart", () => {
    const mainnet = evaluateAlerts(snapshot({ ingestion: { ...snapshot().ingestion, blocksBehind: 40 } }));
    const testnet = evaluateAlerts(
      snapshot({ network: "testnet", ingestion: { ...snapshot().ingestion, blocksBehind: 40 } }),
    );
    assert.notEqual(mainnet[0]?.dedupeKey, testnet[0]?.dedupeKey);
  });

  it("take their limits from the thresholds given", () => {
    const strict = { ...DEFAULT_THRESHOLDS, lagBlocksWarning: 1 };
    assert.equal(evaluateAlerts(snapshot(), strict).length, 1);
  });
});
