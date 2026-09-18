# Database migrations and fixtures

| | |
|---|---|
| Task | I04 Database migrations and fixtures |
| Requirements | POS-01, OPS-01 |
| Owner / reviewer | IBK / kenzman |
| Date | 2026-09-17 |

Deliverable from the task page: implement event, market, position, quote and workflow tables with unique constraints and deterministic fixtures.

## Layout

| Path | What |
|---|---|
| `packages/database/migrations/*.sql` | Versioned SQL, applied in file name order |
| `packages/database/src/lib.ts` | Connection and migration runner (`postgres` 3.4.9), exported as `@stacks-capital/database` |
| `packages/database/src/migrate.ts` | `pnpm db:migrate` |
| `packages/database/src/fixtures.ts`, `seed.ts` | Deterministic fixtures (`@stacks-capital/database/fixtures`), `pnpm fixtures:seed` |
| `packages/database/src/db.test.ts` | Integration tests, `pnpm test:integration` |

## Commands

```bash
pnpm services:up
pnpm db:migrate
pnpm fixtures:seed
pnpm test:integration
```

All three database commands read `DATABASE_URL` from the environment or `.env.local`. There is no default database: a missing `DATABASE_URL` stops the command. Integration tests are skipped when it is not set.

## Migrations

- Files are named `0001_name.sql` and run in order inside one transaction, guarded by an advisory lock so two runners cannot overlap.
- `schema_migrations` stores a SHA256 checksum per file. If an applied file is edited or deleted, the runner stops instead of silently diverging. Changes go in a new file, which keeps migrations backward compatible (page 01).

| File | Tables |
|---|---|
| `0001_registry.sql` | `protocols`, `deployments`, `assets`, `markets`, `capabilities` |
| `0002_quotes_plans.sql` | `quotes`, `plans` |
| `0003_workflows.sql` | `workflows`, `workflow_steps`, `transaction_attempts`, `state_transitions` |
| `0004_chain_evidence.sql` | `chain_blocks`, `raw_events`, `ingestion_checkpoints`, `canonical_activities` |
| `0005_snapshots.sql` | `market_snapshots`, `position_snapshots`, `wallet_balance_snapshots` |
| `0006_identity.sql` (I05) | `partners`, `partner_apps`, `allowed_origins`, `api_keys`, `auth_nonces`, `user_sessions`, plus `app_id` and `owner_address` on `workflows` |
| `0007_projections.sql` (I06) | `price_snapshots`, `reconciliation_runs` |
| `0008_rewards.sql` (I11) | `reward_snapshots` |

Values that core restricts (networks, chains, actions, capability states, workflow states, next actions, position kinds) are Postgres domains, so the database rejects anything core does not know.

## Rules the database enforces

| Rule | Where it comes from | How |
|---|---|---|
| An asset id is never a bare ticker | Page 01 AssetId | `assets` check mirrors `formatAssetId` |
| Deployment ids match core | Page 01 DeploymentId | `deployments` check mirrors `formatDeploymentId` |
| An action that is not disabled needs a verified deployment on the same network | Page 01 registry, page 04 | `capabilities` check and composite foreign key |
| A quote only exists for an action the registry lists for that market | Page 01 | Foreign key to `capabilities` |
| Token quantities are base-10 integer strings, never JSON numbers | Page 01 numbers | `valid_amounts` check on quote amounts and a check on plan steps |
| A plan is on the same network as its quote | Page 01 plan binding | Composite foreign key |
| One workflow per idempotency key | Page 01 workflow engine | Unique constraint |
| A transaction is recorded once; only a non-empty txid counts as broadcast | Page 01, page 06, I02 finding | Unique index on txid, checks on txid and outcome |
| State transitions and transaction attempts are append only | Page 01 evidence | Triggers reject update and delete |
| Raw events and blocks are immutable except the canonical flag | Page 01 read pipeline, K05 | Triggers reject any other change and deletes |
| One canonical block per height, replaceable by a reorg | K05 reorg design | Partial unique index on canonical blocks |
| Unknown or stale values are null with a warning, never zero | Page 01 data model | Snapshot checks require a warning when the value is null |
| Derived rows carry source, block reference, adapter and calculation versions | Page 01 data model | Snapshot and activity columns; block height and hash must be set together |

Money columns use `numeric(78, 0)`, which holds any uint128. Rates are fixed decimals with an explicit scale.

Identity tables (I05) store only SHA256 hashes of API key and session secrets. A sign in nonce must name an origin its app allows (composite foreign key), and a nonce can back at most one session (unique `nonce_id`). API key scopes are a domain, so an unknown scope is rejected.

## Fixtures

`pnpm fixtures:seed` builds rows from the real registry (`packages/config`) and the sandbox adapters (`packages/fixtures`) at `FIXTURE_NOW`:

- Registry: 6 protocols, 18 deployments, 9 assets, 10 markets and 18 capabilities across mainnet and testnet.
- One Zest supply quote and plan produced by the Zest adapter, a workflow moved through `DRAFT`, `QUOTED`, `AWAITING_SIGNATURE`, `SUBMITTED` and `CONFIRMING` with core's `transition`, its step, a broadcast attempt and 4 transitions.
- Three canonical Stacks blocks, one raw event, a checkpoint and a canonical activity linked to the workflow.
- A market snapshot, a known supplied position, an unknown debt position and two wallet balances, one known and one unknown.
- Two partner apps for tenant tests: `app_fixture` (client id `pk_fixture_sandbox`, origin `http://localhost:5173`), which owns the workflow, and `app_other` (client id `pk_other_sandbox`, origin `http://localhost:5174`). No keys or sessions are seeded, because their secrets must not be fixed values.

Ids, hashes and timestamps are fixed, so two fresh databases get identical rows and running the seed again inserts nothing. The integration tests check both.

## Tests

`pnpm test:integration` gives every test its own schema and drops it afterwards.

- Migrations: apply once then do nothing; stop when an applied file was edited; stop when one is missing.
- Fixtures: identical rows in two fresh databases; a second run adds nothing.
- Constraints: each rule in the table above has a test that the bad row is rejected, and where relevant that the good row is accepted.
- Identity (`identity.test.ts`): client id lookup and disabled apps; API keys by scope, wrong secret, revoked and expired; the sign in message binding; a nonce used once and burned by a failed signature; expired nonces and sessions; workflows hidden from another app and another owner.

CI runs migrations, seeds twice and runs these tests against the Compose PostgreSQL.

## Findings

1. **USDCx asset name.** Fixed: adapters and quotes use onchain `usdcx-token`.
2. **Zest vault receipt name.** Fixed: adapters and quotes use onchain `zft`. Product copy may still say zsBTC.
3. **Registry gaps on testnet.** The Zest adapter lists `withdraw_supply` and the Granite adapter lists `withdraw_supply` and `repay`, but `CAPABILITIES` has no testnet record for them. The fixtures store these as disabled with a reason instead of inventing a capability.
4. **Adapter market assets are labels.** Fixed: `Market.suppliedAsset` and `receiptAsset` are `formatAssetId` values. `labelToAsset` still accepts the old labels so historical rows resolve.
5. **Granite contract under the Zest protocol.** Fixed: `v0-8-market` is registered as `protocol: "granite"`.

The fixtures use the verified onchain names for assets. The quote and plan rows are stored exactly as the adapter produced them.

## Unsupported and deferred

- Partners, apps, origins, API keys and sessions landed with I05. Webhooks, usage and the audit log are not created yet; they belong to later tasks.
- `price_snapshots` and `reconciliation_runs` landed with I06 (see docs/engineering/ingestion.md). `reward_snapshots` landed with I11 (see docs/engineering/positions.md). `rate_snapshots`, `liquidity_snapshots` and `cash_flows` are not created yet.
- The database does not enforce which workflow state transitions are allowed; that stays in core's `transition`.
- There is no plan hash column because core's `Plan` has no hash yet (page 03 asks for one).
- `pnpm services:up` and `pnpm services:down` need Linux or macOS.
