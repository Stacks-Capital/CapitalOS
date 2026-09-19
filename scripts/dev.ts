import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const NODE_SCRIPT = ["--experimental-strip-types", "--env-file-if-exists=.env.local"] as const;

/**
 * One command for local Everything Stacks: Postgres, Redis, migrate, seed, API, web.
 * Invokes those tools directly so Corepack's pnpm-native binary is never passed to node.
 */
function fail(result: { status: number | null }): never {
  process.exit(result.status ?? 1);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) fail(result);
}

const webEnv = join(ROOT, "apps/web/.env.local");
if (!existsSync(webEnv)) {
  copyFileSync(join(ROOT, "apps/web/.env.example"), webEnv);
  console.log("Wrote apps/web/.env.local from .env.example");
}

const compose: string[] = ["compose"];
if (existsSync(join(ROOT, ".env.local"))) compose.push("--env-file", ".env.local");
compose.push("up", "-d", "--wait", "postgres", "redis");
run("docker", compose);
run(NODE, [...NODE_SCRIPT, "packages/database/src/migrate.ts"]);
run(NODE, [...NODE_SCRIPT, "packages/database/src/seed.ts"]);

const api = spawn(NODE, [...NODE_SCRIPT, "apps/api/src/server.ts"], { cwd: ROOT, stdio: "inherit" });
const web = spawn(join(ROOT, "apps/web/node_modules/.bin/vite"), [], {
  cwd: join(ROOT, "apps/web"),
  stdio: "inherit",
});

console.log("Capital OS: API http://127.0.0.1:3000  web http://localhost:5180");

function stop(): void {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function onChildExit(other: ChildProcess): (code: number | null) => void {
  return (code) => {
    other.kill("SIGTERM");
    process.exit(code ?? 1);
  };
}

api.on("exit", onChildExit(web));
web.on("exit", onChildExit(api));
