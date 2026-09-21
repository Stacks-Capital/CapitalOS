import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type BoundaryViolation = {
  file: string;
  specifier: string;
  rule: string;
};

type Workspace = { kind: "packages" | "apps" | "prototypes"; name: string };

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const BROWSER_PACKAGES = new Set(["core", "sdk", "client", "wallets", "react", "ui"]);

function workspaceOf(path: string): Workspace | null {
  const [kind, name] = path.split("/");
  if ((kind !== "packages" && kind !== "apps" && kind !== "prototypes") || !name) return null;
  return { kind, name };
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
    }
  };
  for (const dir of ["packages", "apps", "prototypes"]) visit(resolve(root, dir));
  return files;
}

function targetWorkspace(root: string, from: string, specifier: string): Workspace | null {
  if (specifier.startsWith("@stacks-capital/")) {
    const name = specifier.slice("@stacks-capital/".length).split("/")[0];
    return name ? { kind: "packages", name } : null;
  }
  if (!specifier.startsWith(".")) return null;
  return workspaceOf(
    relative(root, resolve(dirname(from), specifier))
      .split(sep)
      .join("/"),
  );
}

function forbiddenRule(from: Workspace, to: Workspace, relativeImport: boolean, testFile: boolean): string | null {
  if (relativeImport && (from.kind !== to.kind || from.name !== to.name)) return "no-relative-cross-workspace-import";
  if (from.kind === "packages" && to.kind === "apps") return "packages-do-not-import-apps";
  if (from.kind === "packages" && from.name === "core" && (to.kind !== "packages" || to.name !== "core")) {
    return "core-has-no-internal-dependencies";
  }
  if (
    from.kind === "packages" &&
    from.name === "adapters" &&
    (to.kind === "apps" || ["ui", "react"].includes(to.name))
  ) {
    return "adapters-do-not-import-ui";
  }
  if (
    from.kind === "apps" &&
    from.name === "web" &&
    ["adapters", "engine", "database", "fixtures", "config"].includes(to.name)
  ) {
    return "web-uses-public-packages-only";
  }
  if (
    !testFile &&
    from.kind === "packages" &&
    from.name === "sdk" &&
    ["adapters", "engine", "database", "fixtures"].includes(to.name)
  ) {
    return "sdk-does-not-import-server-internals";
  }
  if (
    from.kind === "apps" &&
    from.name === "embed-example" &&
    !(to.kind === "apps" && to.name === "embed-example") &&
    !["client", "react", "ui", "core"].includes(to.name)
  ) {
    return "embed-example-uses-public-packages-only";
  }
  if (
    from.kind === "packages" &&
    from.name === "ui" &&
    ["adapters", "engine", "database", "config", "fixtures"].includes(to.name)
  ) {
    return "ui-stays-on-browser-side";
  }
  return null;
}

export function architectureViolations(root: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const absoluteFile of sourceFiles(root)) {
    const file = relative(root, absoluteFile).split(sep).join("/");
    const from = workspaceOf(file);
    if (from === null) continue;
    const testFile = /(?:^|\.)test\.[cm]?tsx?$/.test(file);
    const imports = ts.preProcessFile(readFileSync(absoluteFile, "utf8"), true, true).importedFiles;
    for (const imported of imports) {
      const specifier = imported.fileName;
      if (!testFile && from.kind === "packages" && BROWSER_PACKAGES.has(from.name) && specifier.startsWith("node:")) {
        violations.push({
          file,
          specifier,
          rule: "browser-packages-avoid-node-builtins",
        });
        continue;
      }
      const to = targetWorkspace(root, absoluteFile, specifier);
      if (to === null) continue;
      if (!testFile && file === "apps/partner-example/src/program.ts" && to.kind === "packages" && to.name !== "sdk") {
        violations.push({
          file,
          specifier,
          rule: "partner-program-uses-sdk-only",
        });
        continue;
      }
      const rule = forbiddenRule(from, to, specifier.startsWith("."), testFile);
      if (rule !== null) violations.push({ file, specifier, rule });
    }
  }
  return violations.sort((left, right) =>
    `${left.file}:${left.specifier}:${left.rule}`.localeCompare(`${right.file}:${right.specifier}:${right.rule}`),
  );
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const violations = architectureViolations(root);
  if (violations.length === 0) {
    console.log("Architecture boundaries passed.");
    return;
  }
  for (const violation of violations) {
    console.error(`${violation.rule}: ${violation.file} -> ${violation.specifier}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
