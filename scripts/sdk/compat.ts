import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as client from "../../packages/client/src/index.ts";
import * as sdk from "../../packages/sdk/src/index.ts";
import {
  COMPATIBILITY_MATRIX,
  LAUNCH_DECISION,
  PARTNER_FORBIDDEN_PACKAGES,
  PUBLIC_PACKAGES,
  PUBLIC_VALUE_EXPORTS,
  RELEASE_CANDIDATE_VERSION,
  RELEASE_PACKAGE_FOLDERS,
  RELEASE_PACKAGES,
  SCHEMA_VERSION_LOCK,
  missingExports,
} from "../../packages/sdk/src/surface.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

const missingSdk = missingExports(sdk, PUBLIC_VALUE_EXPORTS["@stacks-capital/sdk"]);
record("public SDK value exports", missingSdk.length === 0, missingSdk.join(", ") || "complete");
const missingClient = missingExports(client, PUBLIC_VALUE_EXPORTS["@stacks-capital/client"]);
record("public client value exports", missingClient.length === 0, missingClient.join(", ") || "complete");
record("schemaVersion lock", client.SCHEMA_VERSION === SCHEMA_VERSION_LOCK, client.SCHEMA_VERSION);

let noDefault = false;
try {
  sdk.requireNetwork(undefined);
} catch {
  noDefault = true;
}
record("SDK requires a network", noDefault, "no default network");

let submitCode = "";
try {
  sdk.createStacksCapital({ network: "mainnet" }).submit();
} catch (error) {
  submitCode = codeOf(error);
}
record("SDK does not broadcast", submitCode === "UNSUPPORTED_ACTION", submitCode || "did not throw");
record("staking stays disabled", sdk.executable("stake", "mainnet") === false, "stake capability disabled");
record(
  "sandbox certifies Zest supply only",
  LAUNCH_DECISION.rows.filter((row) => row.certification === "sandbox").length === 1,
  "zest.supply.mainnet",
);
record("production is no-go", LAUNCH_DECISION.production === "no-go", LAUNCH_DECISION.production);
record("webhooks are not certified", LAUNCH_DECISION.webhooks === "not-certified", LAUNCH_DECISION.webhooks);
record(
  "network switch drops cache scope",
  client.sameScope({ network: "mainnet", address: "SP1" }, { network: "testnet", address: "SP1" }) === false,
  "mainnet vs testnet",
);
record("QUOTE_EXPIRED is requote", client.errorClassOf("QUOTE_EXPIRED") === "requote", "requote");
record(
  "BROADCAST_UNKNOWN is not a write retry",
  client.errorClassOf("BROADCAST_UNKNOWN") === "investigation" &&
    sdk.allowsWriteRetry(sdk.capitalError("BROADCAST_UNKNOWN", "hung")) === false,
  "investigation",
);

const folders = RELEASE_PACKAGE_FOLDERS;

for (const name of RELEASE_PACKAGES) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages", folders[name], "package.json"), "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
    files?: string[];
    private?: boolean;
    engines?: { node?: string };
  };
  const deps = Object.keys(pkg.dependencies ?? {});
  const leaked = PARTNER_FORBIDDEN_PACKAGES.filter((forbidden) => deps.includes(forbidden));
  const isPartnerFacing = (PUBLIC_PACKAGES as readonly string[]).includes(name);
  record(
    `${name} is packable source`,
    pkg.private === true &&
      pkg.files?.[0] === "src" &&
      leaked.length === 0 &&
      pkg.version === RELEASE_CANDIDATE_VERSION &&
      pkg.engines?.node === ">=22",
    leaked.length > 0
      ? `depends on ${leaked.join(", ")}`
      : `${pkg.version}; src only${isPartnerFacing ? "; partner-facing" : "; transitive"}`,
  );
}

const packDir = mkdtempSync(join(tmpdir(), "stacks-capital-pack-"));
try {
  for (const name of RELEASE_PACKAGES) {
    const packed = spawnSync("pnpm", ["--filter", name, "pack", "--pack-destination", packDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    record(
      `pnpm pack ${name}`,
      packed.status === 0,
      packed.status === 0
        ? "tarball written"
        : (packed.error?.message ??
            packed.stderr?.trim() ??
            packed.stdout?.trim() ??
            `exit ${packed.status ?? "unknown"}`),
    );
  }
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

record(
  "compatibility matrix wallets",
  COMPATIBILITY_MATRIX.wallets.join(",") === "leather,xverse",
  COMPATIBILITY_MATRIX.wallets.join(","),
);

console.log("| Check | Result | Detail |");
console.log("|---|---|---|");
for (const check of checks) {
  console.log(`| ${check.name} | ${check.ok ? "pass" : "FAIL"} | ${check.detail.replaceAll("|", "\\|")} |`);
}

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checks.length} compatibility checks failed.`);
  process.exitCode = 1;
} else {
  console.log(
    `\n${checks.length} checks passed. K19/K39: partner surface holds at ${RELEASE_CANDIDATE_VERSION}; production no-go; sandbox Zest supply only.`,
  );
}
