import { execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedFixtures } from "../../packages/database/src/fixtures.ts";
import { setCapabilityOverride } from "../../packages/database/src/ops.ts";
import { connect, MIGRATIONS_DIR, migrate, requireDatabaseUrl } from "../../packages/database/src/lib.ts";

/*
 * Proves a code rollback is safe: the previous release must still work on a database the current
 * release has migrated, because migrations only go forward. It migrates a scratch database with this
 * checkout, starts the previous release's API on it, and checks it can read and write. It also records
 * that the previous release's migrate refuses the newer database, which is why a rollback never runs it,
 * and that an operator switch set before the rollback is still honoured afterwards.
 * Run with: pnpm release:rollback-drill [previous release ref, default origin/main]
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const ref = process.argv[2] ?? "origin/main";
const port = Number(process.env.ROLLBACK_API_PORT ?? "3290");
const origin = "http://localhost:5173";
const clientId = "pk_fixture_sandbox";

const url = requireDatabaseUrl(process.env.DATABASE_URL);
const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || redisUrl === "") throw new Error("REDIS_URL is not set. The previous API needs Redis.");

const commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot })
  .toString()
  .trim();
const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
const database = `rollback_drill_${randomBytes(4).toString("hex")}`;
const drillUrl = new URL(url);
drillUrl.pathname = `/${database}`;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const admin = connect(url);
const workdir = await mkdtemp(join(tmpdir(), "stacks-capital-rollback-"));
let api: ReturnType<typeof spawn> | undefined;

async function versions(): Promise<string[]> {
  const sql = connect(drillUrl.toString());
  const rows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`;
  await sql.end();
  return rows.map((row) => row.version);
}

async function waitForApi(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/v1/markets?network=mainnet`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("The previous release's API did not start");
}

async function request(name: string, path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "x-capital-client-id": clientId, origin, "content-type": "application/json" },
  });
  checks.push({
    name,
    ok: response.status === 200,
    detail: `${init.method ?? "GET"} ${path} returned ${response.status}`,
  });
}

const SWITCHED_OFF = { marketId: "zest.sbtc.vault", action: "supply" };

async function checkSwitchHonoured(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/markets?network=mainnet`, {
    headers: { "x-capital-client-id": clientId, origin },
  });
  const body = (await response.json()) as {
    data?: { items?: { id: string; capabilities: { action: string; state: string }[] }[] };
  };
  const state = body.data?.items
    ?.find((market) => market.id === SWITCHED_OFF.marketId)
    ?.capabilities.find((capability) => capability.action === SWITCHED_OFF.action)?.state;
  checks.push({
    name: "previous API honours an operator switch",
    ok: state !== undefined && state !== "enabled",
    detail: `${SWITCHED_OFF.marketId} ${SWITCHED_OFF.action} shows as ${state ?? "missing"}`,
  });
}

const started = Date.now();
try {
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const fresh = connect(drillUrl.toString());
  const applied = await migrate(fresh, MIGRATIONS_DIR);
  await seedFixtures(fresh);
  await fresh.end();
  const migrated = await versions();

  execSync(`git archive ${commit} | tar -x -C "${workdir}"`, { cwd: repoRoot });
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], {
    cwd: workdir,
    stdio: "ignore",
  });
  const env = { ...process.env, DATABASE_URL: drillUrl.toString(), REDIS_URL: redisUrl, API_PORT: String(port) };

  // The previous migrate must refuse, or find nothing to do. Either way it must not touch the history.
  let oldMigrate: string;
  try {
    oldMigrate = execFileSync("node", ["packages/database/src/migrate.ts"], { cwd: workdir, env, stdio: "pipe" })
      .toString()
      .trim();
  } catch (error) {
    const output = String((error as { stderr?: Buffer }).stderr ?? error);
    oldMigrate = `refused: ${/^Error: (.*)$/m.exec(output)?.[1] ?? "see output"}`;
  }
  const afterOldMigrate = await versions();
  checks.push({
    name: "previous migrate leaves the newer database unchanged",
    ok: JSON.stringify(afterOldMigrate) === JSON.stringify(migrated),
    detail: oldMigrate,
  });

  // An operator switched this off before the rollback. The previous release must still refuse it.
  const switches = connect(drillUrl.toString());
  await setCapabilityOverride(switches, {
    network: "mainnet",
    marketId: SWITCHED_OFF.marketId,
    action: SWITCHED_OFF.action,
    state: "disabled",
    reason: "rollback drill",
    setBy: "rollback-drill",
    setAt: new Date(),
  });
  await switches.end();

  api = spawn("node", ["apps/api/src/server.ts"], { cwd: workdir, env, stdio: "ignore" });
  await waitForApi();
  await checkSwitchHonoured();
  await request("previous API lists markets", "/v1/markets?network=mainnet");
  await request("previous API lists capabilities", "/v1/capabilities?network=mainnet");
  await request("previous API lists earn options", "/v1/earn/options?network=mainnet");
  await request("previous API reads prices", "/v1/prices?network=mainnet");
  await request("previous API writes a sign in challenge", "/v1/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ network: "mainnet", address: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR" }),
  });
  api.kill();
  api = undefined;

  // Rolling forward again must be a no op: nothing the previous release did needs a migration.
  const forward = connect(drillUrl.toString());
  const rerun = await migrate(forward, MIGRATIONS_DIR);
  await forward.end();
  checks.push({
    name: "current migrate finds nothing to apply after the rollback",
    ok: rerun.applied.length === 0,
    detail: `applied ${rerun.applied.length}`,
  });

  const result = {
    previous: { ref, commit },
    current,
    migrationsApplied: applied.applied.length,
    checks,
    totalMs: Date.now() - started,
    passed: checks.every((check) => check.ok),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  api?.kill();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
  await rm(workdir, { recursive: true, force: true });
}
