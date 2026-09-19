import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as sdk from "./index.ts";
import {
  PARTNER_FORBIDDEN_PACKAGES,
  PUBLIC_PACKAGES,
  PUBLIC_VALUE_EXPORTS,
  SCHEMA_VERSION_LOCK,
  missingExports,
} from "./surface.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Manifest = {
  name: string;
  private?: boolean;
  exports?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
};

function manifest(folder: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "packages", folder, "package.json"), "utf8")) as Manifest;
}

describe("K19 SDK release compatibility", () => {
  it("keeps the partner SDK value exports that already shipped", () => {
    assert.deepEqual(missingExports(sdk, PUBLIC_VALUE_EXPORTS["@stacks-capital/sdk"]), []);
    const ui = readFileSync(join(ROOT, "packages/ui/src/index.ts"), "utf8");
    const react = readFileSync(join(ROOT, "packages/react/src/index.ts"), "utf8");
    const client = readFileSync(join(ROOT, "packages/client/src/index.ts"), "utf8");
    for (const name of PUBLIC_VALUE_EXPORTS["@stacks-capital/ui"]) assert.match(ui, new RegExp(`\\b${name}\\b`));
    for (const name of PUBLIC_VALUE_EXPORTS["@stacks-capital/react"]) assert.match(react, new RegExp(`\\b${name}\\b`));
    for (const name of PUBLIC_VALUE_EXPORTS["@stacks-capital/client"]) {
      assert.match(client, new RegExp(`\\b${name}\\b`));
    }
  });

  it("locks the API envelope at schemaVersion 1.0", () => {
    assert.equal(sdk.LAUNCH_DECISION.schemaVersion, SCHEMA_VERSION_LOCK);
    const api = readFileSync(join(ROOT, "apps/api/src/schemas.ts"), "utf8");
    assert.match(api, /export const SCHEMA_VERSION = "1\.0"/);
    const client = readFileSync(join(ROOT, "packages/client/src/types.ts"), "utf8");
    assert.match(client, /export const SCHEMA_VERSION = "1\.0"/);
  });

  it("does not put adapters, engine, database or fixtures on a public package", () => {
    const folders: Record<(typeof PUBLIC_PACKAGES)[number], string> = {
      "@stacks-capital/core": "core",
      "@stacks-capital/wallets": "wallets",
      "@stacks-capital/sdk": "sdk",
      "@stacks-capital/client": "client",
      "@stacks-capital/react": "react",
      "@stacks-capital/ui": "ui",
    };
    for (const name of PUBLIC_PACKAGES) {
      const pkg = manifest(folders[name]);
      assert.equal(pkg.name, name);
      assert.equal(pkg.private, true);
      assert.deepEqual(pkg.files, ["src"]);
      assert.ok(pkg.exports !== undefined, `${name} must declare exports`);
      const deps = Object.keys(pkg.dependencies ?? {});
      for (const forbidden of PARTNER_FORBIDDEN_PACKAGES) {
        assert.equal(deps.includes(forbidden), false, `${name} depends on ${forbidden}`);
      }
    }
  });

  it("refuses to broadcast and refuses a default network", () => {
    assert.throws(() => sdk.requireNetwork(undefined), /no default network/);
    assert.throws(
      () => sdk.createCapitalOS({ network: "mainnet" }).submit(),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "UNSUPPORTED_ACTION",
    );
  });
});
