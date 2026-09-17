import { contract, PROVIDERS, type ProviderEndpoints } from "@stacks-capital/config";
import { ORACLE_MAX_AGE_MS, capitalError, requireNetwork, type StacksNetwork } from "@stacks-capital/core";
import type { AdapterReads, VaultSnapshot } from "@stacks-capital/adapters";
import {
  clarityBoolAfter,
  clarityIntAfter,
  decodeClarityUint,
  encodeStandardPrincipal,
  encodeUint,
} from "./clarity.ts";

const SBTC_ASSET_MASK = 4n;
const SHARE_SAMPLE = 100_000_000n;
const PRODUCT_BUFFER_BPS = "500";

export type LiveReadOptions = {
  network: StacksNetwork;
  owner?: string;
  now?: Date;
  fetch?: typeof fetch;
};

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw capitalError("PROVIDER_TIMEOUT", `${url} HTTP ${res.status}`);
  return res.json();
}

async function callRead(
  fetchImpl: typeof fetch,
  api: string,
  contractId: string,
  fn: string,
  args: string[],
  sender: string,
): Promise<string> {
  const [address, name] = contractId.split(".");
  if (address === undefined || name === undefined) throw new Error(`Bad contract ${contractId}`);
  const res = await fetchImpl(`${api}/v2/contracts/call-read/${address}/${name}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { okay?: boolean; result?: string };
  if (!res.ok || body.okay !== true || body.result === undefined) {
    throw capitalError("PROVIDER_TIMEOUT", `${contractId}.${fn} failed`);
  }
  return body.result;
}

async function vaultSnapshot(
  fetchImpl: typeof fetch,
  api: string,
  contractId: string,
  sender: string,
): Promise<VaultSnapshot> {
  const [pause, total, cap, shares] = await Promise.all([
    callRead(fetchImpl, api, contractId, "get-pause-states", [], sender),
    callRead(fetchImpl, api, contractId, "get-total-assets", [], sender),
    callRead(fetchImpl, api, contractId, "get-cap-supply", [], sender),
    callRead(fetchImpl, api, contractId, "convert-to-shares", [encodeUint(SHARE_SAMPLE)], sender),
  ]);
  return {
    pausedDeposit: clarityBoolAfter(pause, "deposit"),
    pausedRedeem: clarityBoolAfter(pause, "redeem"),
    totalAssets: decodeClarityUint(total).toString(10),
    capSupply: decodeClarityUint(cap).toString(10),
    shareRateNumerator: decodeClarityUint(shares).toString(10),
    shareRateDenominator: SHARE_SAMPLE.toString(10),
  };
}

export async function loadLiveReads(options: LiveReadOptions): Promise<AdapterReads> {
  const network = requireNetwork(options.network);
  if (network !== "mainnet") {
    throw capitalError("CAPABILITY_DISABLED", "Live protocol reads are mainnet-only in this slice");
  }
  const fetchImpl = options.fetch ?? fetch;
  const providers: ProviderEndpoints = PROVIDERS[network];
  const sbtcVault = contract("zest", "v0-vault-sbtc", network).contractId;
  const usdcVault = contract("zest", "v0-vault-usdc", network).contractId;
  const zestDeployer = sbtcVault.split(".")[0];
  if (zestDeployer === undefined) throw new Error("Zest vault contract id is missing a deployer");
  const sender = options.owner ?? zestDeployer;
  const egroup = `${zestDeployer}.v0-egroup`;
  const now = options.now ?? new Date();

  const [limits, vault, debtVault, egroupHex] = await Promise.all([
    getJson(fetchImpl, `${providers.emily}/limits`) as Promise<{
      perDepositMinimum?: number;
      perWithdrawalCap?: number;
      pegCap?: number;
    }>,
    vaultSnapshot(fetchImpl, providers.stacksApi, sbtcVault, sender),
    vaultSnapshot(fetchImpl, providers.stacksApi, usdcVault, sender),
    callRead(fetchImpl, providers.stacksApi, egroup, "resolve", [encodeUint(SBTC_ASSET_MASK)], sender),
  ]);

  const reads: AdapterReads = {
    source: "hiro+emily",
    emilyLimits: {
      perDepositMinimum: String(limits.perDepositMinimum ?? 1000),
      perWithdrawalCap: String(limits.perWithdrawalCap ?? 0),
    },
    vault,
    debtVault,
    riskParams: {
      ltvBorrowBps: clarityIntAfter(egroupHex, "LTV-BORROW").toString(10),
      ltvLiqBps: clarityIntAfter(egroupHex, "LTV-LIQ-PARTIAL").toString(10),
      bufferBps: PRODUCT_BUFFER_BPS,
      sbtcDecimals: "8",
      usdcxDecimals: "6",
    },
    oracle: {
      sbtc: {
        price: "0",
        scale: "8",
        observedAt: now.toISOString(),
        source: "pyth-unavailable",
        stale: true,
        maxAgeMs: ORACLE_MAX_AGE_MS,
      },
      usdcx: {
        price: "0",
        scale: "8",
        observedAt: now.toISOString(),
        source: "pyth-unavailable",
        stale: true,
        maxAgeMs: ORACLE_MAX_AGE_MS,
      },
    },
    swap: {
      poolId: "",
      routerId: contract("bitflow", "dlmm-swap-router-v-1-2", network).contractId,
      amountIn: "0",
      amountOut: "0",
      xAsset: "sbtc",
      stale: true,
      observedAt: now.toISOString(),
      source: "bitflow-ticker",
      maxAgeMs: ORACLE_MAX_AGE_MS,
    },
    position: { collateral: "0", debt: "0" },
  };
  if (limits.pegCap !== undefined) reads.emilyLimits.pegCap = String(limits.pegCap);

  if (options.owner !== undefined) {
    const principal = encodeStandardPrincipal(options.owner);
    const sbtcToken = contract("sbtc", "sbtc-token", network).contractId;
    const usdcx = contract("usdcx", "usdcx", network).contractId;
    const [sbtc, zsbtc, usdc] = await Promise.all([
      callRead(fetchImpl, providers.stacksApi, sbtcToken, "get-balance", [principal], options.owner),
      callRead(fetchImpl, providers.stacksApi, sbtcVault, "get-balance", [principal], options.owner),
      callRead(fetchImpl, providers.stacksApi, usdcx, "get-balance", [principal], options.owner),
    ]);
    reads.balances = {
      sbtc: decodeClarityUint(sbtc).toString(10),
      zsbtc: decodeClarityUint(zsbtc).toString(10),
      usdcx: decodeClarityUint(usdc).toString(10),
    };
  }

  return reads;
}
