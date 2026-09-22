import { createHash } from "node:crypto";
import { CONTRACTS, FUNGIBLE_ASSET_NAME, contract } from "@stacks-capital/config";
import {
  type AssetId,
  bitcoinNative,
  createWorkflow,
  formatAssetId,
  formatDeploymentId,
  parseAssetId,
  type StacksNetwork,
  sip10,
  stacksNative,
  transition,
  type Workflow,
} from "@stacks-capital/core";
import { adapterContext, FIXTURE_NOW, MAINNET_OWNER, MAINNET_READS, sandboxAdapters } from "@stacks-capital/fixtures";
import { toJson } from "./json.ts";
import type { Sql } from "./lib.ts";

export const TABLES = [
  "partners",
  "partner_apps",
  "allowed_origins",
  "protocols",
  "deployments",
  "assets",
  "markets",
  "capabilities",
  "quotes",
  "plans",
  "workflows",
  "workflow_steps",
  "transaction_attempts",
  "state_transitions",
  "chain_blocks",
  "raw_events",
  "ingestion_checkpoints",
  "canonical_activities",
  "market_snapshots",
  "position_snapshots",
  "wallet_balance_snapshots",
] as const;

export type TableCounts = Record<(typeof TABLES)[number], number>;

const NETWORKS: readonly StacksNetwork[] = ["mainnet", "testnet"];
const CALCULATION_VERSION = "fixtures@0.1.0";
const SOURCE = "fixture";

export const FIXTURE_WORKFLOW_ID = "wf_fixture_zest_supply";
export const FIXTURE_IDEMPOTENCY_KEY = "fixture:zest-supply";
export const FIXTURE_ZEST_SUPPLY = { action: "supply", marketId: "zest.sbtc.vault", amount: "99999000" } as const;

// Two tenants: the fixture workflow belongs to the first, so the second proves cross tenant reads are refused.
// 5173 is Playwright. 5180 is local `pnpm web:dev` so a taken 5173 does not land on the other tenant.
export const FIXTURE_APP = {
  id: "app_fixture",
  clientId: "pk_fixture_sandbox",
  origin: "http://localhost:5173",
  origins: ["http://127.0.0.1:5173", "http://127.0.0.1:5180", "http://localhost:5173", "http://localhost:5180"],
} as const;
export const OTHER_APP = {
  id: "app_other",
  clientId: "pk_other_sandbox",
  origin: "http://localhost:5174",
  origins: ["http://127.0.0.1:5174", "http://localhost:5174"],
} as const;

type Row = Record<string, unknown>;

const at = (seconds: number): string => new Date(Date.parse(FIXTURE_NOW) + seconds * 1000).toISOString();
const fixtureHash = (label: string): string =>
  `0x${createHash("sha256").update(`stacks-capital-fixture:${label}`).digest("hex")}`;

// Onchain fungible token names, verified against Hiro contract interfaces on 2026-09-17.
const sbtc = (network: StacksNetwork): AssetId =>
  sip10(network, contract("sbtc", "sbtc-token", network).contractId, FUNGIBLE_ASSET_NAME.sbtc);
const usdcx = (network: StacksNetwork): AssetId =>
  sip10(network, contract("usdcx", "usdcx", network).contractId, FUNGIBLE_ASSET_NAME.usdcx);
const zestShares = (): AssetId =>
  sip10("mainnet", contract("zest", "v0-vault-sbtc", "mainnet").contractId, FUNGIBLE_ASSET_NAME.zestShares);

function labelToAsset(network: StacksNetwork, label: string | undefined): string | null {
  if (label === undefined) return null;
  try {
    return formatAssetId(parseAssetId(label));
  } catch {
    // Adapter markets used to emit labels; keep the aliases so older rows still resolve.
  }
  if (label === "sbtc-token" || label === FUNGIBLE_ASSET_NAME.sbtc) return formatAssetId(sbtc(network));
  if (label === "usdcx" || label === FUNGIBLE_ASSET_NAME.usdcx) return formatAssetId(usdcx(network));
  if (label === "bitcoin native btc") return formatAssetId(bitcoinNative(network));
  if ((label === "zsBTC" || label === FUNGIBLE_ASSET_NAME.zestShares) && network === "mainnet") {
    return formatAssetId(zestShares());
  }
  return null;
}

function assetRow(asset: AssetId, decimals: number | null): Row {
  const native = asset.identity.kind === "native";
  return {
    id: formatAssetId(asset),
    chain: asset.chain,
    network: asset.network,
    kind: asset.identity.kind,
    symbol: asset.identity.kind === "native" ? asset.identity.symbol : null,
    principal: native ? null : asset.identity.kind === "contract" ? asset.identity.principal : null,
    asset_name: asset.identity.kind === "contract" ? asset.identity.assetName : null,
    decimals,
  };
}

function registryRows() {
  const protocols = new Set(CONTRACTS.map((ref) => ref.protocol));
  const deployments: Row[] = CONTRACTS.map((ref) => ({
    id: formatDeploymentId({
      protocol: ref.protocol,
      network: ref.network,
      contractId: ref.contractId,
      revision: ref.revision,
    }),
    protocol_id: ref.protocol,
    network: ref.network,
    contract_id: ref.contractId,
    revision: ref.revision,
    label: ref.label,
    role: ref.role,
  }));

  const assets: Row[] = [assetRow(zestShares(), null)];
  const markets = new Map<string, Row>();
  const capabilities: Row[] = [];

  for (const network of NETWORKS) {
    assets.push(
      assetRow(bitcoinNative(network), 8),
      assetRow(stacksNative(network), 6),
      assetRow(sbtc(network), 8),
      assetRow(usdcx(network), 6),
    );
    const ctx = adapterContext(network);
    const { deposit, withdraw, zest, granite, bitflow } = sandboxAdapters(network);
    for (const adapter of [deposit, withdraw, zest, granite, bitflow]) {
      const described = adapter.describeCapabilities(ctx);
      for (const market of adapter.listMarkets(ctx)) {
        protocols.add(market.protocol);
        markets.set(`${network}/${market.id}`, {
          network,
          id: market.id,
          protocol_id: market.protocol,
          supplied_asset_id: labelToAsset(network, market.suppliedAsset),
          receipt_asset_id: labelToAsset(network, market.receiptAsset),
        });
        // Some adapter markets have no registry record (for example testnet withdraw_supply). Those stay disabled.
        const listed = described.find((record) => record.action === market.action);
        const sibling = listed ?? described[0];
        if (sibling === undefined) throw new Error(`No capability records for ${network} ${market.id}`);
        const capability = listed ?? {
          ...sibling,
          state: "disabled" as const,
          reason: `No ${market.action} capability in registry ${ctx.registryVersion}`,
        };
        const deployment =
          capability.state === "disabled" && listed === undefined
            ? undefined
            : CONTRACTS.find((ref) => ref.network === network && ref.contractId === capability.contractId);
        capabilities.push({
          network,
          market_id: market.id,
          action: market.action,
          state: capability.state,
          reason: capability.reason,
          contract_id: capability.contractId,
          deployment_id:
            deployment === undefined
              ? null
              : formatDeploymentId({
                  protocol: deployment.protocol,
                  network,
                  contractId: deployment.contractId,
                  revision: deployment.revision,
                }),
          adapter_version: capability.adapterVersion,
          registry_version: ctx.registryVersion,
        });
      }
    }
  }

  return {
    protocols: [...protocols].sort().map((id) => ({ id })),
    deployments,
    assets,
    markets: [...markets.values()],
    capabilities,
  };
}

function workflowRows() {
  const ctx = adapterContext("mainnet");
  const { zest } = sandboxAdapters("mainnet");
  const quote = zest.quote(ctx, { ...FIXTURE_ZEST_SUPPLY });
  const plan = zest.buildPlan(ctx, quote, { ...FIXTURE_ZEST_SUPPLY });

  let workflow: Workflow = createWorkflow({
    id: FIXTURE_WORKFLOW_ID,
    network: "mainnet",
    idempotencyKey: FIXTURE_IDEMPOTENCY_KEY,
  });
  const moves = [
    ["QUOTED", "Fresh quote created", "api", quote.id, 0],
    ["AWAITING_SIGNATURE", "Plan validated and sent to the wallet", "sdk", plan.id, 10],
    ["SUBMITTED", "Wallet returned a txid", "wallet", fixtureHash("tx:zest-supply"), 20],
    ["CONFIRMING", "Transaction seen in a block", "ingestion", fixtureHash("block:stacks:2"), 60],
  ] as const;
  for (const [to, reason, actor, evidence, seconds] of moves) {
    workflow = transition(workflow, to, { reason, actor, evidence, at: at(seconds) });
  }

  const stepId = (id: string) => `${FIXTURE_WORKFLOW_ID}:${id}`;
  return {
    quotes: [
      {
        id: quote.id,
        network: quote.network,
        market_id: quote.marketId,
        action: quote.action,
        input: toJson(quote.input),
        expected_output: toJson(quote.expectedOutput),
        minimum_output: quote.minimumOutput === undefined ? null : toJson(quote.minimumOutput),
        fees: toJson(quote.fees),
        snapshots: quote.snapshots,
        warnings: quote.warnings,
        executable: quote.executable,
        registry_version: quote.registryVersion,
        adapter_version: quote.adapterVersion,
        expires_at: quote.expiresAt,
        created_at: at(0),
      },
    ],
    plans: [
      {
        id: plan.id,
        quote_id: plan.quoteId,
        network: plan.network,
        registry_version: plan.registryVersion,
        adapter_version: plan.adapterVersion,
        steps: toJson(plan.steps),
        review_summary: plan.reviewSummary,
        expires_at: plan.expiresAt,
        created_at: at(5),
      },
    ],
    workflows: [
      {
        id: workflow.id,
        network: workflow.network,
        idempotency_key: workflow.idempotencyKey,
        app_id: FIXTURE_APP.id,
        owner_address: MAINNET_OWNER,
        quote_id: quote.id,
        plan_id: plan.id,
        state: workflow.state,
        next_action: workflow.nextAction,
        created_at: at(0),
        updated_at: at(60),
      },
    ],
    workflow_steps: plan.steps.map((step, ordinal) => ({
      id: stepId(step.id),
      workflow_id: FIXTURE_WORKFLOW_ID,
      ordinal,
      kind: step.payload.kind,
      depends_on: step.dependsOn.map(stepId),
    })),
    transaction_attempts: [
      {
        workflow_id: FIXTURE_WORKFLOW_ID,
        step_id: stepId(plan.steps[0]?.id ?? "missing"),
        chain: "stacks",
        network: "mainnet",
        outcome: "BROADCAST",
        txid: fixtureHash("tx:zest-supply"),
        nonce: 0,
        evidence: "wallet response with txid",
        recorded_at: at(20),
      },
    ],
    state_transitions: workflow.transitions.map((move, index) => ({
      workflow_id: FIXTURE_WORKFLOW_ID,
      sequence: index + 1,
      from_state: move.from,
      to_state: move.to,
      reason: move.reason,
      actor: move.actor,
      evidence: move.evidence,
      at: move.at,
    })),
  };
}

function chainRows() {
  const blocks = [0, 1, 2].map((index) => ({
    chain: "stacks",
    network: "mainnet",
    hash: fixtureHash(`block:stacks:${index}`),
    height: 5_000_000 + index,
    parent_hash: fixtureHash(`block:stacks:${index - 1}`),
    canonical: true,
    source: SOURCE,
    observed_at: at(30 + index * 10),
  }));
  const eventId = "evt_fixture_zest_supply";
  return {
    chain_blocks: blocks,
    raw_events: [
      {
        id: eventId,
        chain: "stacks",
        network: "mainnet",
        block_hash: fixtureHash("block:stacks:2"),
        payload: JSON.stringify({ contract: "zest.sbtc.vault", event: "deposit", amount: "99999000" }),
        source: SOURCE,
        canonical: true,
        observed_at: at(60),
      },
    ],
    ingestion_checkpoints: [
      {
        chain: "stacks",
        network: "mainnet",
        height: 5_000_002,
        hash: fixtureHash("block:stacks:2"),
        updated_at: at(60),
      },
    ],
    canonical_activities: [
      {
        id: `${eventId}:supply`,
        raw_event_id: eventId,
        kind: "supply",
        chain: "stacks",
        network: "mainnet",
        block_hash: fixtureHash("block:stacks:2"),
        workflow_id: FIXTURE_WORKFLOW_ID,
        canonical: true,
        adapter_version: sandboxAdapters("mainnet").zest.version,
        calculation_version: CALCULATION_VERSION,
      },
    ],
  };
}

function snapshotRows() {
  const { zest, granite } = sandboxAdapters("mainnet");
  const vault = MAINNET_READS.vault;
  if (vault === undefined) throw new Error("MAINNET_READS has no Zest vault fixture");
  const blockHash = fixtureHash("block:stacks:2");
  const vaultDeployment = contract("zest", "v0-vault-sbtc", "mainnet");
  const marketDeployment = contract("granite", "v0-8-market", "mainnet");
  const deploymentId = (ref: typeof vaultDeployment) =>
    formatDeploymentId({
      protocol: ref.protocol,
      network: "mainnet",
      contractId: ref.contractId,
      revision: ref.revision,
    });

  return {
    market_snapshots: [
      {
        network: "mainnet",
        market_id: "zest.sbtc.vault",
        supply_rate: null,
        borrow_rate: null,
        rate_scale: null,
        available_liquidity: (BigInt(vault.capSupply) - BigInt(vault.totalAssets)).toString(),
        capacity: vault.capSupply,
        paused: vault.pausedDeposit,
        stale: false,
        warnings: ["Supply rate is not part of the sandbox fixture"],
        source: SOURCE,
        observed_at: at(60),
        block_height: 5_000_002,
        block_hash: blockHash,
        adapter_version: zest.version,
        calculation_version: CALCULATION_VERSION,
      },
    ],
    position_snapshots: [
      {
        owner: MAINNET_OWNER,
        network: "mainnet",
        deployment_id: deploymentId(vaultDeployment),
        market_id: "zest.sbtc.vault",
        kind: "supplied",
        protocol_key: MAINNET_OWNER,
        asset_id: formatAssetId(sbtc("mainnet")),
        quantity: FIXTURE_ZEST_SUPPLY.amount,
        stale: false,
        warnings: [],
        source: SOURCE,
        observed_at: at(60),
        block_height: 5_000_002,
        block_hash: blockHash,
        adapter_version: zest.version,
        calculation_version: CALCULATION_VERSION,
      },
      {
        owner: MAINNET_OWNER,
        network: "mainnet",
        deployment_id: deploymentId(marketDeployment),
        market_id: "granite.sbtc.isolated",
        kind: "debt",
        protocol_key: MAINNET_OWNER,
        asset_id: formatAssetId(usdcx("mainnet")),
        quantity: null,
        stale: true,
        warnings: ["Debt read timed out; value unknown"],
        source: SOURCE,
        observed_at: at(60),
        block_height: null,
        block_hash: null,
        adapter_version: granite.version,
        calculation_version: CALCULATION_VERSION,
      },
    ],
    wallet_balance_snapshots: [
      {
        network: "mainnet",
        address: MAINNET_OWNER,
        asset_id: formatAssetId(stacksNative("mainnet")),
        quantity: "5000000",
        stale: false,
        warnings: [],
        source: SOURCE,
        observed_at: at(60),
        block_height: 5_000_002,
        block_hash: blockHash,
      },
      {
        network: "mainnet",
        address: MAINNET_OWNER,
        asset_id: formatAssetId(sbtc("mainnet")),
        quantity: null,
        stale: true,
        warnings: ["Balance provider timed out; value unknown"],
        source: SOURCE,
        observed_at: at(60),
        block_height: null,
        block_hash: null,
      },
    ],
  };
}

// API keys, nonces and sessions are never seeded: keys are shown once at creation and sessions need a signature.
function identityRows() {
  const apps = [
    { ...FIXTURE_APP, partner: "partner_fixture", name: "Fixture sandbox app" },
    { ...OTHER_APP, partner: "partner_other", name: "Other sandbox app" },
  ];
  return {
    partners: apps.map((app) => ({ id: app.partner, name: `${app.name} partner`, created_at: at(0) })),
    partner_apps: apps.map((app) => ({
      id: app.id,
      partner_id: app.partner,
      name: app.name,
      environment: "sandbox",
      client_id: app.clientId,
      created_at: at(0),
    })),
    allowed_origins: apps.flatMap((app) => app.origins.map((origin) => ({ app_id: app.id, origin }))),
  };
}

// Deterministic: fixed ids, hashes and timestamps from FIXTURE_NOW. Running it again inserts nothing.
export async function seedFixtures(sql: Sql): Promise<TableCounts> {
  const rows: Record<(typeof TABLES)[number], Row[]> = {
    ...identityRows(),
    ...registryRows(),
    ...workflowRows(),
    ...chainRows(),
    ...snapshotRows(),
  };
  await sql.begin(async (tx) => {
    for (const table of TABLES) {
      const tableRows = rows[table];
      if (tableRows.length > 0) await tx`INSERT INTO ${tx(table)} ${tx(tableRows)} ON CONFLICT DO NOTHING`;
    }
  });
  return countRows(sql);
}

export async function countRows(sql: Sql): Promise<TableCounts> {
  const counts = {} as TableCounts;
  for (const table of TABLES) {
    const [row] = await sql<{ count: string }[]>`SELECT count(*) AS count FROM ${sql(table)}`;
    counts[table] = Number(row?.count ?? 0);
  }
  return counts;
}
