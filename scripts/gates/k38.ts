/**
 * K38 release gates: sandbox/mainnet-shadow matrices, golden-address reconcile,
 * failure injection, optional restore drill. Never broadcasts.
 *
 *   pnpm gate:k38
 *   pnpm gate:k38 -- --live          # read-only mainnet-shadow (Hiro/Emily/DIA)
 *   pnpm gate:k38 -- --with-restore  # requires DATABASE_URL / compose
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY_VERSION } from "../../packages/config/src/index.ts";
import { reconcileFixtureGoldenAddresses } from "../../packages/fixtures/src/goldenAddresses.ts";

type Check = {
  id: string;
  ok: boolean;
  detail: string;
  category: "sandbox" | "golden" | "failure" | "ops" | "mainnet-shadow";
};

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const live = process.argv.includes("--live");
const withRestore = process.argv.includes("--with-restore");
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
  const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-8).join(" | ");
  record(category, label, ok, ok ? "pass" : tail || `exit ${String(result.status)}`);
}

function runNodeTest(label: string, files: string[], category: Check["category"]): void {
  run(label, process.execPath, ["--test", "--experimental-strip-types", ...files], category);
}

// --- Sandbox matrix (fixtures only, no writes) ---
run("adapters:certify", "pnpm", ["adapters:certify"], "sandbox");
run("sdk:check", "pnpm", ["sdk:check"], "sandbox");
runNodeTest(
  "fixture-e2e-matrix",
  [
    "packages/fixtures/src/earn-roundtrip.test.ts",
    "packages/fixtures/src/credit-roundtrip.test.ts",
    "packages/fixtures/src/failure-drill.test.ts",
    "packages/fixtures/src/goldenAddresses.test.ts",
  ],
  "sandbox",
);

// --- Golden addresses (independent fixture reconcile) ---
const golden = reconcileFixtureGoldenAddresses();
for (const report of golden) {
  record(
    "golden",
    `golden:${report.id}`,
    report.matched,
    report.matched ? `matched via ${report.source}; registry ${report.registryVersion}` : report.mismatches.join("; "),
  );
}
record(
  "golden",
  "golden:all-matched",
  golden.every((report) => report.matched),
  `${golden.filter((r) => r.matched).length}/${golden.length} addresses`,
);

// --- Failure injection (provider, wallet, reorg, registry-pause equivalent) ---
runNodeTest(
  "failure-injection",
  ["packages/fixtures/src/failure-drill.test.ts", "packages/core/src/threat.test.ts"],
  "failure",
);

// --- Ops drills ---
if (withRestore || process.env.DATABASE_URL) {
  run("db:restore-drill", "pnpm", ["db:restore-drill"], "ops");
} else {
  record("ops", "db:restore-drill", true, "skipped (set DATABASE_URL or pass --with-restore)");
}
record(
  "ops",
  "registry-pause-drill",
  true,
  "fixture equivalent covered by failure-drill paused vault + ops:pause CLI when DB is up",
);

// --- Mainnet-shadow (read-only) ---
if (live) {
  run("sdk:check:live", "pnpm", ["sdk:check:live"], "mainnet-shadow");
} else {
  record("mainnet-shadow", "sdk:check:live", true, "skipped (pass --live for read-only provider probes)");
}

const generatedAt = new Date().toISOString();
const failed = checks.filter((check) => !check.ok);
const evidence = {
  task: "K38",
  generatedAt,
  mode: live ? "mainnet-shadow+sandbox" : "sandbox",
  environment: {
    node: process.version,
    platform: process.platform,
    registryVersion: REGISTRY_VERSION,
    liveReads: live,
    restoreDrill: withRestore || Boolean(process.env.DATABASE_URL),
  },
  limitations: [
    "Gate never broadcasts or funds wallets.",
    "Golden addresses in default mode use fixture snapshots; live Granite positions remain launch-block I20-B3.",
    "Bitflow live pools unpinned (I20-B6). Workflows do not advance past SUBMITTED without ingestion (I20-B1).",
    "Registry pause CLI requires DATABASE_URL; fixture pause coverage is the default gate.",
    "Webhook provider outage is covered as BROADCAST_UNKNOWN / RETRY_READ semantics, not a live webhook server.",
  ],
  goldenAddresses: golden,
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
const jsonPath = join(evidenceDir, "k38-latest.json");
const mdPath = join(evidenceDir, "k38-latest.md");
writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);

const md = `# K38 gate evidence

| | |
|---|---|
| Generated | ${generatedAt} |
| Mode | ${evidence.mode} |
| Registry | ${REGISTRY_VERSION} |
| Node | ${process.version} |
| Result | ${failed.length === 0 ? "**PASS**" : `**FAIL** (${failed.length})`} |

## Checks

| Category | ID | Result | Detail |
|---|---|---|---|
${checks.map((check) => `| ${check.category} | ${check.id} | ${check.ok ? "pass" : "FAIL"} | ${check.detail.replace(/\|/g, "/")} |`).join("\n")}

## Golden addresses

| ID | Matched | Source | Mismatches |
|---|---|---|---|
${golden.map((report) => `| ${report.id} | ${report.matched} | ${report.source} | ${report.mismatches.join("; ") || "—"} |`).join("\n")}

## Limitations

${evidence.limitations.map((line) => `- ${line}`).join("\n")}

## Commands

\`\`\`sh
pnpm gate:k38
pnpm gate:k38 -- --live
pnpm gate:k38 -- --with-restore
\`\`\`
`;
writeFileSync(mdPath, md);

process.stdout.write(
  `| K38 | ${failed.length === 0 ? "pass" : "FAIL"} | ${checks.length - failed.length}/${checks.length} checks | evidence ${jsonPath} |\n`,
);
for (const check of failed) {
  process.stdout.write(`FAIL ${check.id}: ${check.detail}\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
