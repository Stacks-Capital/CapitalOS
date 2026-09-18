import { contract, PROVIDERS, type ProviderEndpoints } from "@stacks-capital/config";
import { ORACLE_MAX_AGE_MS, capitalError, requireNetwork, type StacksNetwork } from "@stacks-capital/core";
import type { AdapterReads, OracleSnapshot, VaultSnapshot } from "@stacks-capital/adapters";
import {
  clarityBoolAfter,
  clarityIntAfter,
  clarityUintAfter,
  decodeClarityUint,
  encodeAscii,
  encodeStandardPrincipal,
  encodeUint,
} from "./clarity.ts";

const SBTC_ASSET_MASK = 4n;
const SHARE_SAMPLE = 100_000_000n;
const PRODUCT_BUFFER_BPS = "500";
const DIA_SCALE = "8";

export type ServerReadOptions = {
  network: StacksNetwork;
  owner?: string;
  now?: Date;
  fetch?: typeof fetch;
  hiroApiKey?: string;
};

async function getJson(fetchImpl: typeof fetch, url: string, apiKey?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (apiKey !== undefined) headers["x-api-key"] = apiKey;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
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
  apiKey?: string,
): Promise<string> {
  const [address, name] = contractId.split(".");
  if (address === undefined || name === undefined) throw new Error(`Bad contract ${contractId}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey !== undefined) headers["x-api-key"] = apiKey;
  const res = await fetchImpl(`${api}/v2/contracts/call-read/${address}/${name}/${fn}`, {
    method: "POST",
    headers,
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
  apiKey?: string,
): Promise<VaultSnapshot> {
  const [pause, total, cap, shares] = await Promise.all([
    callRead(fetchImpl, api, contractId, "get-pause-states", [], sender, apiKey),
    callRead(fetchImpl, api, contractId, "get-total-assets", [], sender, apiKey),
    callRead(fetchImpl, api, contractId, "get-cap-supply", [], sender, apiKey),
    callRead(fetchImpl, api, contractId, "convert-to-shares", [encodeUint(SHARE_SAMPLE)], sender, apiKey),
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

type DiaReading = { price: bigint; publishedAt: Date | null; source: string };

function snapshotFromDia(reading: DiaReading, now: Date): OracleSnapshot {
  const publishedAt = reading.publishedAt;
  const age = publishedAt === null ? Number.POSITIVE_INFINITY : now.getTime() - publishedAt.getTime();
  const stale =
    reading.price <= 0n || publishedAt === null || !Number.isFinite(age) || age < 0 || age > ORACLE_MAX_AGE_MS;
  return {
    price: reading.price.toString(10),
    scale: DIA_SCALE,
    observedAt: publishedAt?.toISOString() ?? now.toISOString(),
    source: reading.source,
    stale,
    maxAgeMs: ORACLE_MAX_AGE_MS,
  };
}

async function readDiaFeed(
  fetchImpl: typeof fetch,
  api: string,
  oracleId: string,
  feed: string,
  sender: string,
  apiKey?: string,
): Promise<DiaReading> {
  const hex = await callRead(fetchImpl, api, oracleId, "get-value", [encodeAscii(feed)], sender, apiKey);
  const price = clarityUintAfter(hex, "value");
  const timestampMs = clarityUintAfter(hex, "timestamp");
  return {
    price,
    publishedAt: timestampMs === 0n ? null : new Date(Number(timestampMs)),
    source: `dia-oracle:${feed}`,
  };
}

async function diaOracles(
  fetchImpl: typeof fetch,
  api: string,
  network: StacksNetwork,
  sender: string,
  now: Date,
  apiKey?: string,
): Promise<{ sbtc: OracleSnapshot; usdcx: OracleSnapshot }> {
  const oracleId = contract("dia", "dia-oracle", network).contractId;
  const [btcUsd, sbtcUsd, usdcUsd] = await Promise.all([
    readDiaFeed(fetchImpl, api, oracleId, "BTC/USD", sender, apiKey).catch(
      (): DiaReading => ({ price: 0n, publishedAt: null, source: "dia-oracle:BTC/USD" }),
    ),
    readDiaFeed(fetchImpl, api, oracleId, "sBTC/USD", sender, apiKey).catch(
      (): DiaReading => ({ price: 0n, publishedAt: null, source: "dia-oracle:sBTC/USD" }),
    ),
    readDiaFeed(fetchImpl, api, oracleId, "USDC/USD", sender, apiKey).catch(
      (): DiaReading => ({ price: 0n, publishedAt: null, source: "dia-oracle:USDC/USD" }),
    ),
  ]);
  const sbtcDirect = snapshotFromDia(sbtcUsd, now);
  const sbtcFromBtc = snapshotFromDia(btcUsd, now);
  return {
    sbtc: sbtcDirect.stale ? sbtcFromBtc : sbtcDirect,
    usdcx: snapshotFromDia(usdcUsd, now),
  };
}

export async function loadServerReads(options: ServerReadOptions): Promise<AdapterReads> {
  const network = requireNetwork(options.network);
  if (network !== "mainnet") {
    throw capitalError("CAPABILITY_DISABLED", "Live protocol reads are mainnet-only in this slice");
  }
  const fetchImpl = options.fetch ?? fetch;
  const apiKey = options.hiroApiKey ?? process.env.HIRO_API_KEY;
  const providers: ProviderEndpoints = PROVIDERS[network];
  const sbtcVault = contract("zest", "v0-vault-sbtc", network).contractId;
  const usdcVault = contract("zest", "v0-vault-usdc", network).contractId;
  const zestDeployer = sbtcVault.split(".")[0];
  if (zestDeployer === undefined) throw new Error("Zest vault contract id is missing a deployer");
  const sender = options.owner ?? zestDeployer;
  const egroup = `${zestDeployer}.v0-egroup`;
  const now = options.now ?? new Date();

  const [limits, vault, debtVault, egroupHex, oracle] = await Promise.all([
    getJson(fetchImpl, `${providers.emily}/limits`, apiKey) as Promise<{
      perDepositMinimum?: number;
      perWithdrawalCap?: number;
      pegCap?: number;
    }>,
    vaultSnapshot(fetchImpl, providers.stacksApi, sbtcVault, sender, apiKey),
    vaultSnapshot(fetchImpl, providers.stacksApi, usdcVault, sender, apiKey),
    callRead(fetchImpl, providers.stacksApi, egroup, "resolve", [encodeUint(SBTC_ASSET_MASK)], sender, apiKey),
    diaOracles(fetchImpl, providers.stacksApi, network, sender, now, apiKey),
  ]);

  const reads: AdapterReads = {
    source: "hiro+emily+dia",
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
    oracle,
    swap: {
      poolId: "",
      routerId: contract("bitflow", "dlmm-swap-router-v-1-2", network).contractId,
      amountIn: "0",
      amountOut: "0",
      xAsset: "sbtc",
      stale: true,
      observedAt: now.toISOString(),
      source: "bitflow-unpinned",
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
      callRead(fetchImpl, providers.stacksApi, sbtcToken, "get-balance", [principal], options.owner, apiKey),
      callRead(fetchImpl, providers.stacksApi, sbtcVault, "get-balance", [principal], options.owner, apiKey),
      callRead(fetchImpl, providers.stacksApi, usdcx, "get-balance", [principal], options.owner, apiKey),
    ]);
    reads.balances = {
      sbtc: decodeClarityUint(sbtc).toString(10),
      zsbtc: decodeClarityUint(zsbtc).toString(10),
      usdcx: decodeClarityUint(usdc).toString(10),
    };
  }

  return reads;
}
