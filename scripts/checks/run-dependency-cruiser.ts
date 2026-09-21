import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
const supported = major === 22 || major === 24 || major >= 26;

if (!supported) {
  console.warn(
    `Skipping dependency-cruiser on unsupported Node ${process.versions.node}; native boundaries still passed.`,
  );
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = spawnSync(
    join(root, "node_modules", ".bin", "depcruise"),
    ["--config", ".dependency-cruiser.cjs", "packages", "apps", "scripts", "prototypes"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
