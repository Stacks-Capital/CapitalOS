import { parseArgs } from "node:util";
import { identifyBitcoinNetwork, parseNetworks, pickRateLimitHeaders, redact, type Network } from "./lib.ts";
import { PYTH_BTC_USD_FEED, TARGETS } from "./targets.ts";

type Reply = { status: number | null; ms: number; headers: Headers; text: string };
type Row = { network: Network; target: string; check: string; ok: boolean; status: number | null; ms: number; detail: string };

const { values } = parseArgs({
  options: { network: { type: "string" }, json: { type: "boolean", default: false } },
});
const networks = parseNetworks(values.network);
const hiroKey = process.env.HIRO_API_KEY || undefined;
const pythKey = process.env.PYTH_API_KEY || undefined;
const hiroHeaders: Record<string, string> = hiroKey ? { "x-api-key": hiroKey } : {};
const rows: Row[] = [];

async function call(url: string, headers: Record<string, string> = {}): Promise<Reply> {
  const started = performance.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    return { status: res.status, ms: Math.round(performance.now() - started), headers: res.headers, text };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { status: null, ms: Math.round(performance.now() - started), headers: new Headers(), text };
  }
}

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function limits(reply: Reply): string {
  const picked = pickRateLimitHeaders(reply.headers);
  const second = picked["x-ratelimit-limit-second"];
  const minute = picked["x-ratelimit-limit-minute"];
  const cache = reply.headers.get("cf-cache-status");
  const limit = second || minute ? `limit ${second ?? "?"}/s and ${minute ?? "?"}/min` : "no rate limit headers";
  return cache ? `${limit} (cache ${cache})` : limit;
}

// A cached response carries the limit headers of whoever filled the cache, so status checks bypass it.
function fresh(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}probe=${Date.now()}`;
}

function record(network: Network, target: string, check: string, reply: Reply, ok: boolean, detail: string): void {
  rows.push({ network, target, check, ok, status: reply.status, ms: reply.ms, detail: redact(detail, [hiroKey, pythKey]) });
}

async function probeStacks(network: Network): Promise<number | null> {
  const { stacksApi, contracts } = TARGETS[network];

  type Status = { status: string; server_version: string; chain_tip: { block_height: number; burn_block_height: number } };
  const anon = await call(fresh(`${stacksApi}/extended`));
  const status = parse<Status>(anon.text);
  record(
    network, "Hiro Stacks API", "status without key", anon, status?.status === "ready",
    status
      ? `tip ${status.chain_tip.block_height}, burn ${status.chain_tip.burn_block_height}, ${status.server_version}, ${limits(anon)}`
      : anon.text.slice(0, 120),
  );

  if (hiroKey) {
    const keyed = await call(fresh(`${stacksApi}/extended`), hiroHeaders);
    record(network, "Hiro Stacks API", "status with key", keyed, keyed.status === 200, limits(keyed));
  }

  const page = await call(`${stacksApi}/extended/v1/tx?limit=51`, hiroHeaders);
  record(
    network, "Hiro Stacks API", "rejects limit above 50", page, page.status === 400,
    parse<{ message?: string }>(page.text)?.message ?? page.text.slice(0, 120),
  );

  const pox = await call(`${stacksApi}/v2/pox`, hiroHeaders);
  const poxBody = parse<{ contract_id?: string; current_cycle?: { id: number } }>(pox.text);
  record(
    network, "Bitcoin Staking (PoX)", "pox info", pox, pox.status === 200,
    `${poxBody?.contract_id ?? "?"}, cycle ${poxBody?.current_cycle?.id ?? "?"}`,
  );

  for (const contract of contracts) {
    const reply = await call(`${stacksApi}/extended/v1/contract/${contract.id}`, hiroHeaders);
    const height = parse<{ block_height?: number }>(reply.text)?.block_height;
    record(
      network, contract.target, `contract ${contract.label}`, reply, reply.status === 200,
      reply.status === 200 ? `${contract.id} deployed at block ${height ?? "?"}` : `${contract.id} not found on this network`,
    );
  }

  return status?.chain_tip.burn_block_height ?? null;
}

async function probeBitcoin(network: Network, burnHeight: number | null): Promise<void> {
  for (const api of TARGETS[network].bitcoinApis) {
    const genesis = await call(`${api.base}/block-height/0`);
    const tip = await call(`${api.base}/blocks/tip/height`);
    const chain = genesis.status === 200 ? identifyBitcoinNetwork(genesis.text) : "unreachable";
    const tipHeight = Number.parseInt(tip.text, 10);
    const known = Number.isFinite(tipHeight);
    const gap = known && burnHeight !== null ? tipHeight - burnHeight : null;
    const sameChain = gap === null || Math.abs(gap) <= 2;
    record(
      network, api.name, "chain and tip vs Stacks burn height", tip,
      tip.status === 200 && chain === api.expectedChain && sameChain,
      `${chain}, tip ${known ? tipHeight : "?"}, Stacks burn height ${burnHeight ?? "?"}, gap ${gap ?? "?"}, ${limits(tip)}`,
    );
  }
}

async function probeEmily(network: Network): Promise<void> {
  const { emily, stacksApi } = TARGETS[network];

  type Chainstate = { stacksBlockHeight: number; stacksBlockHash: string; bitcoinBlockHeight: number };
  const chain = await call(`${emily}/chainstate`);
  const state = parse<Chainstate>(chain.text);
  if (state === null) {
    record(network, "sBTC Emily", "chainstate", chain, false, chain.text.slice(0, 120));
  } else {
    const block = await call(`${stacksApi}/extended/v2/blocks/0x${state.stacksBlockHash}`, hiroHeaders);
    record(
      network, "sBTC Emily", "tracks the same Stacks chain as Hiro", chain, block.status === 200,
      `Emily at Stacks ${state.stacksBlockHeight} and Bitcoin ${state.bitcoinBlockHeight}, its block hash is ${block.status === 200 ? "found" : "not found"} on Hiro`,
    );
  }

  const page = await call(`${emily}/deposit?status=confirmed&pageSize=1`);
  const body = parse<{ nextToken?: string | null; deposits?: unknown[] }>(page.text);
  record(
    network, "sBTC Emily", "deposit pagination", page, page.status === 200 && body !== null && "nextToken" in body,
    `${body?.deposits?.length ?? 0} item returned, nextToken ${body?.nextToken ? "present" : "absent"}, ${limits(page)}`,
  );

  const lim = await call(`${emily}/limits`);
  const limBody = parse<{ perDepositMinimum?: number | null; perWithdrawalCap?: number | null }>(lim.text);
  record(
    network, "sBTC Emily", "limits", lim, lim.status === 200,
    `perDepositMinimum ${limBody?.perDepositMinimum ?? "null"}, perWithdrawalCap ${limBody?.perWithdrawalCap ?? "null"}`,
  );
}

async function probePyth(network: Network): Promise<void> {
  const url = `${TARGETS[network].hermes}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD_FEED}&parsed=true`;
  const anon = await call(url);
  record(
    network, "Pyth Hermes", "price without key", anon, anon.status === 401,
    anon.status === 401 ? "rejected, API key required" : `unexpected: ${anon.text.slice(0, 80)}`,
  );
  if (pythKey) {
    const keyed = await call(url, { authorization: `Bearer ${pythKey}` });
    record(network, "Pyth Hermes", "price with key", keyed, keyed.status === 200, limits(keyed));
  }
}

async function probeBitflow(network: Network): Promise<void> {
  const ticker = TARGETS[network].bitflowTicker;
  if (ticker === null) {
    rows.push({ network, target: "Bitflow", check: "public ticker", ok: true, status: null, ms: 0, detail: "no public endpoint for this network" });
    return;
  }
  const reply = await call(ticker);
  const pairs = parse<unknown[]>(reply.text);
  record(
    network, "Bitflow", "public ticker", reply, reply.status === 200 && Array.isArray(pairs),
    `${Array.isArray(pairs) ? pairs.length : 0} pairs, ${limits(reply)}`,
  );
}

for (const network of networks) {
  const burnHeight = await probeStacks(network);
  await probeBitcoin(network, burnHeight);
  await probeEmily(network);
  await probePyth(network);
  await probeBitflow(network);
}

const observedAt = new Date().toISOString();
if (values.json) {
  console.log(JSON.stringify({ observedAt, hiroKey: Boolean(hiroKey), pythKey: Boolean(pythKey), rows }, null, 2));
} else {
  console.log(`Observed at ${observedAt}. Hiro key ${hiroKey ? "set" : "not set"}, Pyth key ${pythKey ? "set" : "not set"}.\n`);
  console.log("| Network | Target | Check | Matches expectation | HTTP | ms | Detail |");
  console.log("|---|---|---|---|---|---|---|");
  for (const row of rows) {
    console.log(`| ${row.network} | ${row.target} | ${row.check} | ${row.ok ? "yes" : "no"} | ${row.status ?? "none"} | ${row.ms} | ${row.detail.replaceAll("|", "\\|")} |`);
  }
}
