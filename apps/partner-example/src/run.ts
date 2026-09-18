import { createCapitalOS } from "@stacks-capital/sdk";
import { DISPOSABLE_TEST_MNEMONIC } from "./disposable-test-account.ts";
import { startDemoCapitalApi } from "./demo-server.ts";
import { ownerFromMnemonic, signUnsignedPlan } from "./host-sign.ts";
import { runZestSupply, stakingIsDisabled } from "./program.ts";

const live = process.argv.includes("--live");
const apiBase = process.env.CAPITAL_API_URL;
const mnemonic = process.env.CAPITAL_MNEMONIC ?? DISPOSABLE_TEST_MNEMONIC;
const derived = ownerFromMnemonic(mnemonic, "mainnet").address;
const owner = process.env.CAPITAL_OWNER ?? derived;

const demo = apiBase === undefined || apiBase === "" ? await startDemoCapitalApi({ live }) : null;

try {
  const result = await runZestSupply({
    apiBase: demo?.url ?? apiBase ?? "",
    network: "mainnet",
    owner,
  });
  const signed = await signUnsignedPlan(result.plan, mnemonic, "mainnet");
  const outcome = createCapitalOS({ network: "mainnet" }).inspectWalletResult(signed);
  console.log("Capital OS partner example");
  console.log(`  mode: ${live ? "live Hiro/Emily/DIA" : "fixtures"}`);
  console.log(`  api: ${demo?.url ?? apiBase}`);
  console.log(`  owner: ${owner}`);
  console.log(`  quote: ${result.quote.id} executable=${String(result.quote.executable)}`);
  console.log(`  receipt: ${result.shares} ${result.receiptAsset}`);
  console.log(`  plan: ${result.plan.id}`);
  console.log(`  review: ${result.plan.reviewSummary}`);
  console.log(`  sdk validate: ok`);
  console.log(`  workflow: ${result.workflowState}`);
  console.log(
    `  host sign: ${outcome} ${signed.functionName} ${signed.contractId} (${String(signed.transaction.length)} hex chars, not broadcast)`,
  );
  console.log(`  staking enabled: ${String(!stakingIsDisabled())}`);
} finally {
  await demo?.close();
}
