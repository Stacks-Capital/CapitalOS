import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { architectureViolations } from "./architecture.ts";

const temps: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "capitalos-boundaries-"));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

after(() => {
  for (const root of temps) rmSync(root, { recursive: true, force: true });
});

describe("native architecture boundary gate", () => {
  it("accepts public browser package imports", () => {
    const root = tree({
      "packages/client/src/index.ts": "export const client = true;\n",
      "apps/web/src/page.ts": 'import { client } from "@stacks-capital/client";\nexport const page = client;\n',
      "apps/embed-example/src/config.ts": "export const config = true;\n",
      "apps/embed-example/src/main.ts":
        'import { config } from "./config.ts";\nimport { client } from "@stacks-capital/client";\nexport const app = [config, client];\n',
    });
    assert.deepEqual(architectureViolations(root), []);
  });

  it("rejects server internals in the web app and cross-workspace relative imports", () => {
    const root = tree({
      "packages/adapters/src/index.ts": "export const adapter = true;\n",
      "apps/web/src/page.ts":
        'import { adapter } from "@stacks-capital/adapters";\nimport { adapter as relative } from "../../../packages/adapters/src/index.ts";\nexport const page = [adapter, relative];\n',
    });
    assert.deepEqual(
      architectureViolations(root)
        .map(({ rule }) => rule)
        .sort(),
      ["no-relative-cross-workspace-import", "web-uses-public-packages-only"],
    );
  });

  it("rejects Node builtins from production browser exports but permits test helpers", () => {
    const root = tree({
      "packages/sdk/src/index.ts": 'import fs from "node:fs";\nexport const sdk = fs;\n',
      "packages/sdk/src/index.test.ts": 'import assert from "node:assert/strict";\nassert.ok(true);\n',
    });
    assert.deepEqual(
      architectureViolations(root).map(({ rule }) => rule),
      ["browser-packages-avoid-node-builtins"],
    );
  });

  it("requires the partner program to consume CapitalOS through the public SDK", () => {
    const root = tree({
      "packages/engine/src/index.ts": "export const engine = true;\n",
      "apps/partner-example/src/program.ts":
        'import { engine } from "@stacks-capital/engine";\nexport const partner = engine;\n',
    });
    assert.deepEqual(
      architectureViolations(root).map(({ rule }) => rule),
      ["partner-program-uses-sdk-only"],
    );
  });
});
