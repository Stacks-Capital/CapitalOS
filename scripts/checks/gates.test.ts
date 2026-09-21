import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "node_modules", ".bin");
const temps: string[] = [];

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function installed(command: string, args: string[]): boolean {
  return run(command, args, ROOT).status === 0;
}

function tempTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "capitalos-gates-"));
  temps.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("lint gate", () => {
  it("passes strict equality", () => {
    const dir = tempTree({
      "ok.ts": "export const same = (a: number, b: number): boolean => a === b;\n",
    });
    assert.equal(run(join(BIN, "biome"), ["lint", "ok.ts"], dir).status, 0);
  });

  it("fails loose equality", () => {
    const dir = tempTree({
      "bad.ts": "export const same = (a: number, b: number): boolean => a == b;\n",
    });
    const result = run(join(BIN, "biome"), ["lint", "bad.ts"], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /noDoubleEquals/);
  });
});

const dependencyCruiserSupported = (() => {
  const major = Number(process.versions.node.split(".")[0]);
  return major === 22 || major === 24 || major >= 26;
})();

describe("package boundary gate", {
  skip: dependencyCruiserSupported ? false : "dependency-cruiser does not support this Node release",
}, () => {
  const cruise = (dir: string) =>
    run(
      join(BIN, "depcruise"),
      ["--config", join(ROOT, ".dependency-cruiser.cjs"), "--output-type", "err", "packages", "apps"],
      dir,
    );

  it("passes packages that only import their own files", () => {
    const dir = tempTree({
      "tsconfig.base.json": "{}\n",
      "packages/core/src/index.ts": 'import { one } from "./one.ts";\nexport const core = one;\n',
      "packages/core/src/one.ts": "export const one = 1;\n",
      "apps/web/src/page.ts": "export const page = 1;\n",
    });
    const result = cruise(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("fails when core imports an adapter and an adapter imports the web app", () => {
    const dir = tempTree({
      "tsconfig.base.json": "{}\n",
      "packages/core/src/index.ts":
        'import { adapter } from "../../adapters/src/index.ts";\nexport const core = adapter;\n',
      "packages/adapters/src/index.ts":
        'import { page } from "../../../apps/web/src/page.ts";\nexport const adapter = page;\n',
      "apps/web/src/page.ts": "export const page = 1;\n",
    });
    const result = cruise(dir);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0);
    for (const rule of [
      "core-has-no-internal-dependencies",
      "adapters-do-not-import-ui",
      "no-relative-import-into-another-package",
    ]) {
      assert.match(output, new RegExp(rule));
    }
  });
});

describe("secret scanning gate", {
  skip: installed("gitleaks", ["version"]) ? false : "gitleaks is not installed",
}, () => {
  it("passes a folder without secrets", () => {
    const dir = tempTree({ "notes.md": "nothing secret here\n" });
    assert.equal(run("gitleaks", ["dir", dir, "--no-banner", "--redact"], dir).status, 0);
  });

  it("fails a folder with a token", () => {
    // Built at runtime so this file never contains a token itself.
    const dir = tempTree({
      "config.ts": `export const token = "ghp_${randomBytes(18).toString("hex")}";\n`,
    });
    assert.equal(run("gitleaks", ["dir", dir, "--no-banner", "--redact"], dir).status, 1);
  });
});

describe("local services", {
  skip: installed("docker", ["compose", "version"]) ? false : "docker is not installed",
}, () => {
  it("defines postgres and redis", () => {
    const result = run("docker", ["compose", "-f", join(ROOT, "compose.yaml"), "config", "--services"], ROOT);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n").sort(), ["postgres", "redis"]);
  });

  it("publishes host ports from POSTGRES_PORT and REDIS_PORT on localhost only", () => {
    const result = spawnSync("docker", ["compose", "-f", join(ROOT, "compose.yaml"), "config", "--format", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, POSTGRES_PORT: "15432", REDIS_PORT: "16379" },
    });
    assert.equal(result.status, 0, result.stderr);
    type Port = { published?: string; host_ip?: string };
    const config = JSON.parse(result.stdout) as {
      services: Record<string, { ports?: Port[] }>;
    };
    assert.deepEqual(config.services.postgres?.ports?.[0], {
      ...config.services.postgres?.ports?.[0],
      published: "15432",
      host_ip: "127.0.0.1",
    });
    assert.deepEqual(config.services.redis?.ports?.[0], {
      ...config.services.redis?.ports?.[0],
      published: "16379",
      host_ip: "127.0.0.1",
    });
  });
});
