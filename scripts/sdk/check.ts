import {
  canSubmitWrite,
  createCapitalOS,
  executable,
  loadLiveReads,
  requireNetwork,
} from "../../packages/sdk/src/index.ts";
import {
  FIXTURE_NOW,
  MAINNET_OWNER,
  MAINNET_READS,
  TESTNET_OWNER,
  TESTNET_READS,
} from "../../packages/fixtures/src/index.ts";
import type { AdapterReads } from "../../packages/sdk/src/index.ts";

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
const live = process.argv.includes("--live");

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

function mustThrowCode(name: string, fn: () => unknown, code: string): void {
  try {
    fn();
    record(name, false, "did not throw");
  } catch (error) {
    const got = codeOf(error);
    record(name, got === code, got === code ? code : `threw ${got || String(error)}`);
  }
}

const now = live ? new Date() : new Date(FIXTURE_NOW);
const reads: AdapterReads = live
  ? await loadLiveReads({ network: "mainnet", owner: MAINNET_OWNER, now })
  : MAINNET_READS;

if (live) {
  record("live Emily limits", Number(reads.emilyLimits.perDepositMinimum) > 0, `min ${reads.emilyLimits.perDepositMinimum}`);
  record("live Zest vault", reads.vault !== undefined && reads.vault.pausedDeposit === false, `assets ${reads.vault?.totalAssets ?? "none"}`);
  record("live Granite LTV", reads.riskParams?.ltvBorrowBps === "8000" && reads.riskParams.ltvLiqBps === "8500", `borrow ${reads.riskParams?.ltvBorrowBps} liq ${reads.riskParams?.ltvLiqBps}`);
  record("Pyth left fail-closed", reads.oracle?.sbtc.stale === true, reads.oracle?.sbtc.source ?? "missing");
  record("no sBTC-USDCx Bitflow pool pinned", reads.swap?.stale === true, reads.swap?.source ?? "missing");
}

const os = createCapitalOS({
  network: "mainnet",
  reads,
  owner: MAINNET_OWNER,
  now,
});
const signing = { sender: MAINNET_OWNER };

try {
  requireNetwork(undefined);
  record("network is required", false, "accepted a missing network");
} catch (error) {
  record("network is required", error instanceof Error && /no default network/.test(error.message), "no default network");
}

mustThrowCode("SDK does not broadcast", () => os.submit(), "UNSUPPORTED_ACTION");

const deposit = os.quoteAndPlan({
  action: "deposit_sbtc",
  marketId: "sbtc.deposit",
  amount: "100000000",
  recipient: MAINNET_OWNER,
  maxFee: "1000",
});
record(
  "BTC → sBTC quote/plan",
  deposit.quote.executable && deposit.plan.steps[0]?.payload.kind === "bitcoin_deposit" && os.validate(deposit.plan, deposit.quote, signing).ok,
  `plan ${deposit.plan.steps[0]?.payload.kind}, source ${reads.source ?? "fixture"}`,
);

const supply = os.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });
record(
  "Zest supply quote/plan",
  supply.quote.executable && os.validate(supply.plan, supply.quote, signing).ok,
  `shares ${supply.quote.expectedOutput[0]?.quantity.toString(10) ?? "none"}`,
);

if (live) {
  mustThrowCode("Granite borrow fail-closed without Pyth", () => os.quote({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" }), "ORACLE_STALE");
  mustThrowCode("Bitflow swap fail-closed without sBTC-USDCx pool", () => os.quote({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" }), "ORACLE_STALE");
} else {
  const borrow = os.quoteAndPlan({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "50000000000" });
  record("Granite USDCx borrow (fixture oracle)", os.validate(borrow.plan, borrow.quote, signing).ok, borrow.plan.steps.map((step) => step.id).join(",") || "no steps");
  const swap = os.quoteAndPlan({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" });
  record(
    "Bitflow swap (fixture route)",
    swap.plan.steps[0]?.payload.kind === "stacks_contract_call" && os.validate(swap.plan, swap.quote, signing).ok,
    `min-out ${swap.quote.minimumOutput?.quantity.toString(10) ?? "none"}`,
  );
}

let flow = os.startWorkflow({ id: "sdk-check", idempotencyKey: "sdk-check" });
flow = os.recordQuote(flow, supply.quote);
flow = os.recordPlan(flow, supply.plan);
record(
  "workflow stops at AWAITING_SIGNATURE",
  flow.state === "AWAITING_SIGNATURE" && canSubmitWrite(flow.state),
  flow.state,
);

const testnet = createCapitalOS({
  network: "testnet",
  reads: TESTNET_READS,
  owner: TESTNET_OWNER,
  now,
});
const testnetDeposit = testnet.quote({
  action: "deposit_sbtc",
  marketId: "sbtc.deposit",
  amount: "10000",
  recipient: TESTNET_OWNER,
});
record("testnet sBTC deposit is not executable", testnetDeposit.executable === false, testnetDeposit.warnings.join(" ") || "disabled");
record("staking is disabled", executable("stake", "mainnet") === false, "stake capability disabled");

console.log(`| Check | Result | Detail |`);
console.log("|---|---|---|");
for (const check of checks) {
  console.log(`| ${check.name} | ${check.ok ? "pass" : "FAIL"} | ${check.detail.replaceAll("|", "\\|")} |`);
}

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checks.length} SDK checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${checks.length} SDK checks passed. Mode: ${live ? "live Hiro/Emily reads" : "fixtures"}. Unsigned plans only.`);
}
