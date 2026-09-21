/**
 * K40: pilot entry/exit evidence, partner sandbox certification, launch decision
 * with named ownership and rollback triggers. Production remains no-go.
 *
 *   pnpm gate:k40
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canSubmitWrite } from "../../packages/core/src/index.ts";
import { createExecutionEngine } from "../../packages/engine/src/index.ts";
import { FIXTURE_NOW, MAINNET_OWNER, MAINNET_READS } from "../../packages/fixtures/src/index.ts";
import { createCapitalOS } from "../../packages/sdk/src/index.ts";
import { LAUNCH_DECISION } from "../../packages/sdk/src/surface.ts";

type Check = {
  id: string;
  ok: boolean;
  detail: string;
  category: "pilot" | "partner" | "gates" | "ownership" | "decision";
};

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const checks: Check[] = [];

function record(category: Check["category"], id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail, category });
}

function run(label: string, command: string, args: string[], category: Check["category"]): void {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: false,
  });
  const ok = result.status === 0;
  const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-6).join(" | ");
  record(category, label, ok, ok ? "pass" : tail || `exit ${String(result.status)}`);
}

const PILOT_IDS = ["pilot-01", "pilot-02", "pilot-03", "pilot-04", "pilot-05"] as const;

type PilotAttempt = {
  pilotId: string;
  owner: string;
  workflowId: string;
  entryState: string;
  exitState: string;
  entryOk: boolean;
  exitOk: boolean;
  limitations: string[];
};

function runSandboxPilotAttempts(): PilotAttempt[] {
  const now = new Date(FIXTURE_NOW);
  const engine = createExecutionEngine({
    network: "mainnet",
    reads: MAINNET_READS,
    owner: MAINNET_OWNER,
    now,
  });
  const os = createCapitalOS({ network: "mainnet", now });
  const { quote, plan } = engine.quoteAndPlan({
    action: "supply",
    marketId: "zest.sbtc.vault",
    amount: "100000000",
  });

  return PILOT_IDS.map((pilotId) => {
    let flow = os.startWorkflow({
      id: `wf_${pilotId}`,
      idempotencyKey: `k40-${pilotId}-zest-supply`,
    });
    flow = os.recordQuote(flow, quote);
    flow = os.recordPlan(flow, plan, quote, { sender: MAINNET_OWNER });
    const entryOk = flow.state === "AWAITING_SIGNATURE" && canSubmitWrite(flow.state);
    const entryState = flow.state;
    flow = os.recordRejection(flow, `${pilotId} declined in wallet`);
    const exitOk = flow.state === "USER_REJECTED" && os.resumeHint(flow).terminal === true;
    return {
      pilotId,
      owner: MAINNET_OWNER,
      workflowId: flow.id,
      entryState,
      exitState: flow.state,
      entryOk,
      exitOk,
      limitations: [
        "Fixture sandbox only; no mainnet broadcast.",
        "Exit is wallet rejection (USER_REJECTED). On-chain exit needs ingestion past SUBMITTED (I20-B1).",
      ],
    };
  });
}

// --- Ownership / decision surface ---
record(
  "ownership",
  "named-owners",
  Boolean(
    LAUNCH_DECISION.ownership.productOwner &&
      LAUNCH_DECISION.ownership.incidentOwner &&
      LAUNCH_DECISION.ownership.supportOwner,
  ),
  `product=${LAUNCH_DECISION.ownership.productOwner}; incident=${LAUNCH_DECISION.ownership.incidentOwner}; support=${LAUNCH_DECISION.ownership.supportOwner}`,
);
record(
  "ownership",
  "rollback-triggers",
  LAUNCH_DECISION.rollbackTriggers.length >= 3,
  `${LAUNCH_DECISION.rollbackTriggers.length} triggers`,
);
record("decision", "production-no-go", LAUNCH_DECISION.production === "no-go", LAUNCH_DECISION.production);
record(
  "decision",
  "closed-earn-pilot-no-go",
  LAUNCH_DECISION.closedEarnPilot === "no-go",
  LAUNCH_DECISION.closedEarnPilot,
);
record(
  "decision",
  "sandbox-cert-go",
  LAUNCH_DECISION.sandboxCertification === "go",
  LAUNCH_DECISION.sandboxCertification,
);
record(
  "decision",
  "go-live-requirements",
  LAUNCH_DECISION.goLiveRequirements.length >= 4 && LAUNCH_DECISION.p0Gates.join(",") === "K38,K39,K40",
  LAUNCH_DECISION.p0Gates.join(","),
);

// --- Five pilot entry/exit sessions ---
const pilots = runSandboxPilotAttempts();
for (const attempt of pilots) {
  record(
    "pilot",
    `pilot:${attempt.pilotId}`,
    attempt.entryOk && attempt.exitOk,
    attempt.entryOk && attempt.exitOk
      ? `${attempt.entryState} → ${attempt.exitState} (${attempt.workflowId})`
      : `entry=${attempt.entryState} exit=${attempt.exitState}`,
  );
}
record(
  "pilot",
  "pilot:five-sessions",
  pilots.length >= 5 && pilots.every((row) => row.entryOk && row.exitOk),
  `${pilots.filter((row) => row.entryOk && row.exitOk).length}/${pilots.length}`,
);

// --- External partner sandbox certification ---
run("partner:example", "pnpm", ["partner:example"], "partner");
run("sdk:compat", "pnpm", ["sdk:compat"], "partner");
run(
  "launch-tests",
  process.execPath,
  ["--test", "--experimental-strip-types", "packages/sdk/src/launch.test.ts"],
  "partner",
);

// --- Prior P0 gate evidence present ---
for (const gate of ["k38", "k39"] as const) {
  const path = join(root, `docs/release/evidence/${gate}-latest.json`);
  let ok = false;
  let detail = `missing ${path}`;
  if (existsSync(path)) {
    try {
      const evidence = JSON.parse(readFileSync(path, "utf8")) as { summary?: { failed?: number } };
      ok = (evidence.summary?.failed ?? 1) === 0;
      detail = ok ? "prior evidence pass" : "prior evidence reported failures";
    } catch (error) {
      detail = error instanceof Error ? error.message : "invalid json";
    }
  }
  record("gates", `evidence:${gate}`, ok, detail);
}

const launchDoc = join(root, "docs/release/launch-decision.md");
const launchText = existsSync(launchDoc) ? readFileSync(launchDoc, "utf8") : "";
record(
  "decision",
  "launch-decision-doc",
  /K40/.test(launchText) && /rollback/i.test(launchText) && /Kenzman/.test(launchText) && /IBK/.test(launchText),
  launchDoc,
);

const generatedAt = new Date().toISOString();
const failed = checks.filter((check) => !check.ok);
const evidence = {
  task: "K40",
  generatedAt,
  decision: {
    production: LAUNCH_DECISION.production,
    closedEarnPilot: LAUNCH_DECISION.closedEarnPilot,
    sandboxCertification: LAUNCH_DECISION.sandboxCertification,
    ownership: LAUNCH_DECISION.ownership,
    rollbackTriggers: [...LAUNCH_DECISION.rollbackTriggers],
    goLiveRequirements: [...LAUNCH_DECISION.goLiveRequirements],
    p0Gates: [...LAUNCH_DECISION.p0Gates],
  },
  pilots,
  limitations: [
    "Production and closed earn pilot remain no-go.",
    "Five pilot sessions are fixture sandbox entry→reject exit; real-wallet M1–M10 remain unrun.",
    "On-chain confirmed exit is blocked until ingestion links txs past SUBMITTED (I20-B1).",
    "Partner certification is the in-repo partner-example + sdk:compat path (packages still private).",
    "Go-live still requires B4/B5 disclosures and reachable on-call contacts outside this gate.",
  ],
  checks,
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    failedIds: failed.map((check) => check.id),
  },
};

const evidenceDir = join(root, "docs/release/evidence");
mkdirSync(evidenceDir, { recursive: true });
const jsonPath = join(evidenceDir, "k40-latest.json");
const mdPath = join(evidenceDir, "k40-latest.md");
writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);

const md = `# K40 gate evidence

| | |
|---|---|
| Generated | ${generatedAt} |
| Production | **${LAUNCH_DECISION.production}** |
| Closed earn pilot | **${LAUNCH_DECISION.closedEarnPilot}** |
| Sandbox certification | **${LAUNCH_DECISION.sandboxCertification}** |
| Result | ${failed.length === 0 ? "**PASS**" : `**FAIL** (${failed.length})`} |

## Ownership

| Role | Owner |
|---|---|
| Product | ${LAUNCH_DECISION.ownership.productOwner} |
| Incident | ${LAUNCH_DECISION.ownership.incidentOwner} |
| Support | ${LAUNCH_DECISION.ownership.supportOwner} |
| Reviewer | ${LAUNCH_DECISION.ownership.reviewer} |

## Pilot sessions

| Pilot | Entry | Exit | Workflow |
|---|---|---|---|
${pilots.map((row) => `| ${row.pilotId} | ${row.entryState} | ${row.exitState} | ${row.workflowId} |`).join("\n")}

## Checks

| Category | ID | Result | Detail |
|---|---|---|---|
${checks.map((check) => `| ${check.category} | ${check.id} | ${check.ok ? "pass" : "FAIL"} | ${check.detail.replace(/\|/g, "/")} |`).join("\n")}

## Rollback triggers

${LAUNCH_DECISION.rollbackTriggers.map((line) => `- ${line}`).join("\n")}

## Go-live requirements (all still blocking production)

${LAUNCH_DECISION.goLiveRequirements.map((line) => `- ${line}`).join("\n")}

## Limitations

${evidence.limitations.map((line) => `- ${line}`).join("\n")}

## Commands

\`\`\`sh
pnpm gate:k40
pnpm partner:example
\`\`\`
`;
writeFileSync(mdPath, md);

process.stdout.write(
  `| K40 | ${failed.length === 0 ? "pass" : "FAIL"} | ${checks.length - failed.length}/${checks.length} checks | evidence ${jsonPath} |\n`,
);
for (const check of failed) {
  process.stdout.write(`FAIL ${check.id}: ${check.detail}\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
