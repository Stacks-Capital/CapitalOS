import { CONTRACTS, PROVIDERS, type ContractRef } from "../../packages/config/src/index.ts";

type AbiFn = { name: string; access: string };
type ContractBody = { tx_id?: string; block_height?: number; abi?: string | { functions?: AbiFn[] }; error?: string };

const REQUIRED: Record<string, string[]> = {
  "sbtc-token": ["transfer", "get-balance", "get-decimals"],
  "sbtc-deposit": ["complete-deposit-wrapper"],
  "sbtc-withdrawal": ["initiate-withdrawal-request", "validate-recipient"],
  "sbtc-registry": ["get-deposit-status", "get-withdrawal-request"],
  "v0-vault-sbtc": ["deposit", "redeem", "get-pause-states", "get-underlying"],
  "v0-vault-usdc": ["deposit", "get-pause-states", "get-underlying"],
  "v0-8-market": ["borrow", "repay", "collateral-add", "collateral-remove"],
  "dlmm-swap-router-v-1-2": ["swap-x-for-y-simple-range-multi", "swap-y-for-x-simple-range-multi"],
  "pox-5": ["get-pox-info"],
  usdcx: ["transfer", "get-balance"],
};

async function load(contract: ContractRef): Promise<{ ok: boolean; detail: string }> {
  const base = PROVIDERS[contract.network].stacksApi;
  const res = await fetch(`${base}/extended/v1/contract/${contract.contractId}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as ContractBody;
  if (res.status !== 200) return { ok: false, detail: `${contract.contractId} HTTP ${res.status}` };
  const abi = typeof body.abi === "string" ? (JSON.parse(body.abi) as { functions?: AbiFn[] }) : body.abi;
  const names = new Set((abi?.functions ?? []).map((fn) => fn.name));
  const missing = (REQUIRED[contract.label] ?? []).filter((name) => !names.has(name));
  return {
    ok: missing.length === 0,
    detail:
      missing.length === 0 ? `height ${body.block_height}, ${names.size} functions` : `missing ${missing.join(", ")}`,
  };
}

const rows: { contract: string; network: string; ok: boolean; detail: string }[] = [];
for (const contract of CONTRACTS.filter((item) => !item.role.startsWith("superseded"))) {
  const result = await load(contract);
  rows.push({ contract: contract.contractId, network: contract.network, ...result });
}

console.log("| Network | Contract | Matches registry methods | Detail |");
console.log("|---|---|---|---|");
for (const row of rows) {
  console.log(`| ${row.network} | ${row.contract} | ${row.ok ? "yes" : "no"} | ${row.detail.replaceAll("|", "\\|")} |`);
}
if (rows.some((row) => !row.ok)) process.exitCode = 1;
