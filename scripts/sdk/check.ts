import {
  canSubmitWrite,
  parsePlan,
  parseQuote,
  requireNetwork,
  serializePlan,
  serializeQuote,
} from "../../packages/core/src/index.ts";
import { createExecutionEngine, executable, loadServerReads } from "../../packages/engine/src/index.ts";
import { createStacksCapital } from "../../packages/sdk/src/index.ts";
import {
  FIXTURE_NOW,
  MAINNET_OWNER,
  MAINNET_READS,
  TESTNET_OWNER,
  TESTNET_READS,
} from "../../packages/fixtures/src/index.ts";
import type { AdapterReads } from "../../packages/engine/src/index.ts";

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
  ? await loadServerReads({ network: "mainnet", owner: MAINNET_OWNER, now })
  : MAINNET_READS;

if (live) {
  record(
    "live Emily limits",
    Number(reads.emilyLimits.perDepositMinimum) > 0,
    `min ${reads.emilyLimits.perDepositMinimum}`,
  );
  record(
    "live Zest vault",
    reads.vault !== undefined && reads.vault.pausedDeposit === false,
    `assets ${reads.vault?.totalAssets ?? "none"}`,
  );
  record(
    "live Granite LTV",
    reads.riskParams?.ltvBorrowBps === "8000" && reads.riskParams.ltvLiqBps === "8500",
    `borrow ${reads.riskParams?.ltvBorrowBps} liq ${reads.riskParams?.ltvLiqBps}`,
  );
  record(
    "DIA sBTC price",
    reads.oracle?.sbtc !== undefined,
    `${reads.oracle?.sbtc.source ?? "missing"} stale=${String(reads.oracle?.sbtc.stale)}`,
  );
  record(
    "DIA USDCx fail-closed unless fresh",
    reads.oracle?.usdcx !== undefined,
    `${reads.oracle?.usdcx.source ?? "missing"} stale=${String(reads.oracle?.usdcx.stale)}`,
  );
  record("no sBTC-USDCx Bitflow pool pinned", reads.swap?.stale === true, reads.swap?.source ?? "missing");
}

const engine = createExecutionEngine({
  network: "mainnet",
  reads,
  owner: MAINNET_OWNER,
  now,
});
const os = createStacksCapital({ network: "mainnet", now });
const signing = { sender: MAINNET_OWNER };

try {
  requireNetwork(undefined);
  record("network is required", false, "accepted a missing network");
} catch (error) {
  record(
    "network is required",
    error instanceof Error && /no default network/.test(error.message),
    "no default network",
  );
}

mustThrowCode("SDK does not broadcast", () => os.submit(), "UNSUPPORTED_ACTION");

const deposit = engine.quoteAndPlan({
  action: "deposit_sbtc",
  marketId: "sbtc.deposit",
  amount: "100000000",
  recipient: MAINNET_OWNER,
  maxFee: "1000",
});
record(
  "BTC → sBTC quote/plan",
  deposit.quote.executable &&
    deposit.plan.steps[0]?.payload.kind === "bitcoin_deposit" &&
    os.validate(deposit.plan, deposit.quote, signing).ok,
  `plan ${deposit.plan.steps[0]?.payload.kind}, source ${reads.source ?? "fixture"}`,
);

const supply = engine.quoteAndPlan({ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" });
const zft =
  supply.quote.expectedOutput[0]?.asset.identity.kind === "contract" &&
  supply.quote.expectedOutput[0].asset.identity.assetName === "zft";
record(
  "Zest supply quote/plan",
  supply.quote.executable && zft && os.validate(supply.plan, supply.quote, signing).ok,
  `shares ${supply.quote.expectedOutput[0]?.quantity.toString(10) ?? "none"} asset ${zft ? "zft" : "wrong"}`,
);

if (live) {
  const graniteCode = (() => {
    try {
      engine.quote({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "1000000" });
      return "quoted";
    } catch (error) {
      return codeOf(error);
    }
  })();
  record(
    "Granite borrow uses DIA and fail-closes if stale",
    graniteCode === "ORACLE_STALE" || graniteCode === "INSUFFICIENT_BALANCE",
    graniteCode,
  );
  mustThrowCode(
    "Bitflow swap fail-closed without sBTC-USDCx pool",
    () => engine.quote({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" }),
    "ORACLE_STALE",
  );
} else {
  const borrow = engine.quoteAndPlan({ action: "borrow", marketId: "granite.sbtc.isolated", amount: "50000000000" });
  const usdcx =
    borrow.quote.expectedOutput[0]?.asset.identity.kind === "contract" &&
    borrow.quote.expectedOutput[0].asset.identity.assetName === "usdcx-token";
  record(
    "Granite USDCx borrow (fixture oracle)",
    usdcx && os.validate(borrow.plan, borrow.quote, signing).ok,
    borrow.plan.steps.map((step) => step.id).join(",") || "no steps",
  );
  const swap = engine.quoteAndPlan({ action: "swap", marketId: "bitflow.sbtc-usdcx", amount: "100000000" });
  record(
    "Bitflow swap (fixture route)",
    swap.plan.steps[0]?.payload.kind === "stacks_contract_call" && os.validate(swap.plan, swap.quote, signing).ok,
    `min-out ${swap.quote.minimumOutput?.quantity.toString(10) ?? "none"}`,
  );
}

const roundTrip = os.validate(parsePlan(serializePlan(supply.plan)), parseQuote(serializeQuote(supply.quote)), signing);
record("SDK validates the JSON quote/plan wire format", roundTrip.ok, roundTrip.reasons.join("; ") || "ok");

let flow = os.startWorkflow({ id: "sdk-check", idempotencyKey: "sdk-check" });
flow = os.recordQuote(flow, supply.quote);
flow = os.recordPlan(flow, supply.plan, supply.quote, signing);
record(
  "workflow stops at AWAITING_SIGNATURE",
  flow.state === "AWAITING_SIGNATURE" && canSubmitWrite(flow.state),
  flow.state,
);

const testnet = createExecutionEngine({
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
record(
  "testnet sBTC deposit is not executable",
  testnetDeposit.executable === false,
  testnetDeposit.warnings.join(" ") || "disabled",
);
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
  console.log(
    `\n${checks.length} checks passed. Mode: ${live ? "live Hiro/Emily/DIA reads" : "fixtures"}. Engine quotes; SDK validates. Unsigned plans only.`,
  );
}
