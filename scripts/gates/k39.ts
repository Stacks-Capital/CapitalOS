/**
 * K39: version public SDK packages, pack release-candidate artifacts, prove a clean
 * install can import them, and run the partner example. Never publishes to a registry.
 *
 *   pnpm gate:k39
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPATIBILITY_MATRIX,
  PARTNER_FORBIDDEN_PACKAGES,
  RELEASE_CANDIDATE_VERSION,
  RELEASE_PACKAGE_FOLDERS,
  RELEASE_PACKAGES,
} from "../../packages/sdk/src/surface.ts";
import { classifyWalletError } from "../../packages/wallets/src/index.ts";

type Check = {
  id: string;
  ok: boolean;
  detail: string;
  category: "version" | "pack" | "install" | "matrix" | "partner" | "migration";
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

// --- Version alignment ---
for (const name of RELEASE_PACKAGES) {
  const folder = RELEASE_PACKAGE_FOLDERS[name];
  const pkg = JSON.parse(readFileSync(join(root, "packages", folder, "package.json"), "utf8")) as {
    version?: string;
    private?: boolean;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const leaked = PARTNER_FORBIDDEN_PACKAGES.filter((forbidden) =>
    Object.keys(pkg.dependencies ?? {}).includes(forbidden),
  );
  record(
    "version",
    `version:${name}`,
    pkg.version === RELEASE_CANDIDATE_VERSION &&
      pkg.private === true &&
      pkg.engines?.node === ">=22" &&
      leaked.length === 0,
    leaked.length > 0
      ? `depends on ${leaked.join(", ")}`
      : `${pkg.version}; private; engines.node=${pkg.engines?.node ?? "missing"}`,
  );
}

const reactPkg = JSON.parse(readFileSync(join(root, "packages/react/package.json"), "utf8")) as {
  peerDependencies?: { react?: string };
};
record(
  "matrix",
  "react-peer",
  reactPkg.peerDependencies?.react === COMPATIBILITY_MATRIX.react,
  reactPkg.peerDependencies?.react ?? "missing",
);

const nodeMajor = Number(process.versions.node.split(".")[0]);
record(
  "matrix",
  "node-major",
  (COMPATIBILITY_MATRIX.nodeMajor as readonly number[]).includes(nodeMajor),
  `running ${process.version}; supported ${COMPATIBILITY_MATRIX.nodeMajor.join(",")}`,
);

for (const wallet of COMPATIBILITY_MATRIX.wallets) {
  const rejected = classifyWalletError(wallet, { code: 4001 });
  const unsupported =
    wallet === "xverse"
      ? classifyWalletError(wallet, { code: -32001 })
      : classifyWalletError(wallet, { code: -32601 });
  record(
    "matrix",
    `wallet:${wallet}`,
    rejected === "USER_REJECTED" && unsupported === "UNSUPPORTED_WALLET",
    `reject=${rejected}; unsupported=${unsupported}`,
  );
}

// --- Pack all release packages ---
const packRoot = mkdtempSync(join(tmpdir(), "capitalos-k39-pack-"));
const tarballs: Record<string, string> = {};
try {
  for (const name of RELEASE_PACKAGES) {
    const folder = RELEASE_PACKAGE_FOLDERS[name];
    const packed = spawnSync(
      "pnpm",
      ["--filter", name, "pack", "--pack-destination", packRoot],
      { cwd: root, encoding: "utf8" },
    );
    const expected = join(packRoot, `${name.replace("@", "").replace("/", "-")}-${RELEASE_CANDIDATE_VERSION}.tgz`);
    const ok = packed.status === 0;
    if (ok) tarballs[name] = expected;
    record(
      "pack",
      `pack:${name}`,
      ok,
      ok ? expected : (packed.stderr?.trim() || packed.stdout?.trim() || `exit ${String(packed.status)}`),
    );
  }

  // --- Clean install from tarballs (extracted private workspace; no registry) ---
  const workspaceRoot = join(packRoot, "workspace");
  const pkgsRoot = join(workspaceRoot, "pkgs");
  const consumerRoot = join(workspaceRoot, "consumer");
  mkdirSync(pkgsRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n  - consumer\n");
  writeFileSync(join(workspaceRoot, "package.json"), `${JSON.stringify({ name: "capitalos-k39-workspace", private: true }, null, 2)}\n`);

  for (const name of RELEASE_PACKAGES) {
    const tarball = tarballs[name];
    if (!tarball) continue;
    const folder = RELEASE_PACKAGE_FOLDERS[name];
    const dest = join(pkgsRoot, folder);
    mkdirSync(dest, { recursive: true });
    const extracted = spawnSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components", "1"], {
      encoding: "utf8",
    });
    if (extracted.status !== 0) {
      record("install", `extract:${name}`, false, extracted.stderr?.trim() || `exit ${String(extracted.status)}`);
    }
  }

  const workspaceDeps = Object.fromEntries(RELEASE_PACKAGES.map((name) => [name, "workspace:*"]));
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "capitalos-k39-consumer",
        private: true,
        type: "module",
        dependencies: {
          ...workspaceDeps,
          react: "19.3.0",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerRoot, "smoke.mjs"),
    `const { createCapitalOS, RELEASE_CANDIDATE_VERSION, COMPATIBILITY_MATRIX, requireNetwork } = await import("@stacks-capital/sdk");
const { SCHEMA_VERSION } = await import("@stacks-capital/client");
const { classifyWalletError } = await import("@stacks-capital/wallets");
if (RELEASE_CANDIDATE_VERSION !== "${RELEASE_CANDIDATE_VERSION}") throw new Error("version mismatch");
if (SCHEMA_VERSION !== "${COMPATIBILITY_MATRIX.schemaVersion}") throw new Error("schema mismatch");
requireNetwork("mainnet");
createCapitalOS({ network: "mainnet" });
if (classifyWalletError("leather", { code: 4001 }) !== "USER_REJECTED") throw new Error("leather");
if (classifyWalletError("xverse", { code: -32001 }) !== "UNSUPPORTED_WALLET") throw new Error("xverse");
if (!COMPATIBILITY_MATRIX.wallets.includes("leather")) throw new Error("matrix");
console.log("k39-consumer-ok", RELEASE_CANDIDATE_VERSION, SCHEMA_VERSION);
`,
  );

  // Packed manifests still pin @stacks-capital/*@0.1.0; rewrite to workspace: for the local proof.
  for (const name of RELEASE_PACKAGES) {
    const folder = RELEASE_PACKAGE_FOLDERS[name];
    const pkgPath = join(pkgsRoot, folder, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const block = pkg[field];
      if (!block) continue;
      for (const dep of Object.keys(block)) {
        if (dep.startsWith("@stacks-capital/")) block[dep] = "workspace:*";
      }
    }
    // Drop private-only workspace test deps that are not in the RC set.
    if (pkg.devDependencies) {
      for (const dep of [...Object.keys(pkg.devDependencies)]) {
        if (dep.startsWith("@stacks-capital/") && !(RELEASE_PACKAGES as readonly string[]).includes(dep)) {
          delete pkg.devDependencies[dep];
        }
      }
    }
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const install = spawnSync("pnpm", ["install"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: process.env,
  });
  record(
    "install",
    "clean-install",
    install.status === 0,
    install.status === 0
      ? "pnpm install from packed tarballs (extracted workspace)"
      : (install.stderr?.trim() || install.stdout?.trim() || `exit ${String(install.status)}`).slice(0, 400),
  );

  if (install.status === 0) {
    const smoke = spawnSync(process.execPath, ["--experimental-strip-types", "smoke.mjs"], {
      cwd: consumerRoot,
      encoding: "utf8",
    });
    record(
      "install",
      "clean-import-smoke",
      smoke.status === 0 && (smoke.stdout ?? "").includes("k39-consumer-ok"),
      smoke.status === 0
        ? (smoke.stdout ?? "").trim().split("\n").at(-1) ?? "ok"
        : (smoke.stderr?.trim() || smoke.stdout?.trim() || `exit ${String(smoke.status)}`).slice(0, 400),
    );
  } else {
    record("install", "clean-import-smoke", false, "skipped (install failed)");
  }
} finally {
  rmSync(packRoot, { recursive: true, force: true });
}

// --- Partner example against workspace RC (same versions partners will consume) ---
run("partner:example", "pnpm", ["partner:example"], "partner");
run("sdk:compat", "pnpm", ["sdk:compat"], "partner");

// --- Migration notes present ---
const migration = join(root, "docs/guides/sdk-migration-0.1.md");
try {
  const text = readFileSync(migration, "utf8");
  record(
    "migration",
    "migration-notes",
    text.includes(RELEASE_CANDIDATE_VERSION) && text.includes("Breaking"),
    migration,
  );
} catch {
  record("migration", "migration-notes", false, `missing ${migration}`);
}

const generatedAt = new Date().toISOString();
const failed = checks.filter((check) => !check.ok);
const evidence = {
  task: "K39",
  generatedAt,
  releaseCandidate: RELEASE_CANDIDATE_VERSION,
  environment: {
    node: process.version,
    platform: process.platform,
    cwd: root,
  },
  compatibility: COMPATIBILITY_MATRIX,
  limitations: [
    "Clean install extracts packed tarballs into a disposable workspace (packages stay private / unpublished).",
    "Source packs ship TypeScript; consumers need Node >=22 with --experimental-strip-types or a bundler.",
    "Partner example still uses workspace fixtures/engine for the demo API host; partner-facing imports stay on the public SDK surface.",
    "Browser wallet UX is covered by unit classifyWalletError + embed/UI tests, not a live Leather/Xverse session in this gate.",
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
const jsonPath = join(evidenceDir, "k39-latest.json");
const mdPath = join(evidenceDir, "k39-latest.md");
writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);

const md = `# K39 gate evidence

| | |
|---|---|
| Generated | ${generatedAt} |
| Release candidate | ${RELEASE_CANDIDATE_VERSION} |
| Node | ${process.version} |
| Result | ${failed.length === 0 ? "**PASS**" : `**FAIL** (${failed.length})`} |

## Checks

| Category | ID | Result | Detail |
|---|---|---|---|
${checks.map((check) => `| ${check.category} | ${check.id} | ${check.ok ? "pass" : "FAIL"} | ${check.detail.replace(/\|/g, "/")} |`).join("\n")}

## Compatibility matrix

| Dimension | Supported |
|---|---|
| Node major | ${COMPATIBILITY_MATRIX.nodeMajor.join(", ")} |
| React | ${COMPATIBILITY_MATRIX.react} |
| Wallets | ${COMPATIBILITY_MATRIX.wallets.join(", ")} |
| schemaVersion | ${COMPATIBILITY_MATRIX.schemaVersion} |

## Limitations

${evidence.limitations.map((line) => `- ${line}`).join("\n")}

## Commands

\`\`\`sh
pnpm gate:k39
pnpm partner:example
pnpm sdk:compat
\`\`\`
`;
writeFileSync(mdPath, md);

process.stdout.write(
  `| K39 | ${failed.length === 0 ? "pass" : "FAIL"} | ${checks.length - failed.length}/${checks.length} checks | evidence ${jsonPath} |\n`,
);
for (const check of failed) {
  process.stdout.write(`FAIL ${check.id}: ${check.detail}\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
