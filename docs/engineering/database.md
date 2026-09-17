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
| `db/migrations/*.sql` | Versioned SQL, applied in file name order |
| `scripts/db/lib.ts` | Connection and migration runner (`postgres` 3.4.9) |
| `scripts/db/migrate.ts` | `pnpm db:migrate` |
| `scripts/db/fixtures.ts`, `seed.ts` | Deterministic fixtures, `pnpm fixtures:seed` |
| `scripts/db/db.test.ts` | Integration tests, `pnpm test:integration` |

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

## Fixtures

`pnpm fixtures:seed` builds rows from the real registry (`packages/config`) and the sandbox adapters (`packages/fixtures`) at `FIXTURE_NOW`:

- Registry: 6 protocols, 18 deployments, 9 assets, 10 markets and 18 capabilities across mainnet and testnet.
- One Zest supply quote and plan produced by the Zest adapter, a workflow moved through `DRAFT`, `QUOTED`, `AWAITING_SIGNATURE`, `SUBMITTED` and `CONFIRMING` with core's `transition`, its step, a broadcast attempt and 4 transitions.
- Three canonical Stacks blocks, one raw event, a checkpoint and a canonical activity linked to the workflow.
- A market snapshot, a known supplied position, an unknown debt position and two wallet balances, one known and one unknown.

Ids, hashes and timestamps are fixed, so two fresh databases get identical rows and running the seed again inserts nothing. The integration tests check both.

## Tests

`pnpm test:integration` gives every test its own schema and drops it afterwards.

- Migrations: apply once then do nothing; stop when an applied file was edited; stop when one is missing.
- Fixtures: identical rows in two fresh databases; a second run adds nothing.
- Constraints: each rule in the table above has a test that the bad row is rejected, and where relevant that the good row is accepted.

CI runs migrations, seeds twice and runs these tests against the Compose PostgreSQL.

## Findings for kenzman

1. **USDCx asset name.** The onchain fungible token is `usdcx-token` on mainnet and testnet (Hiro contract interface), but the Granite adapter builds USDCx as `sip10(..., "usdcx")`. Post conditions naming `usdcx` would reference a token that does not exist.
2. **Zest vault receipt name.** The vault's fungible token is `zft`, while the Zest adapter uses `zsBTC`.
3. **Registry gaps on testnet.** The Zest adapter lists `withdraw_supply` and the Granite adapter lists `withdraw_supply` and `repay`, but `CAPABILITIES` has no testnet record for them. The fixtures store these as disabled with a reason instead of inventing a capability.
4. **Adapter market assets are labels.** `Market.suppliedAsset` and `receiptAsset` use labels such as `sbtc-token` rather than asset ids, so the fixtures map them to canonical ids.
5. **Granite contract under the Zest protocol.** `v0-8-market` is registered with `protocol: "zest"` while its capabilities say `granite`.

The fixtures use the verified onchain names for assets. The quote and plan rows are stored exactly as the adapter produced them.

## Unsupported and deferred

- Identity and commercial tables (partners, API keys, sessions, webhooks, usage, audit log) belong with tenant access in I05.
- `reconciliation_runs`, `price_snapshots`, `rate_snapshots`, `liquidity_snapshots`, `reward_events` and `cash_flows` are not created yet; ingestion and projections (I06, I11) will define what they need.
- The database does not enforce which workflow state transitions are allowed; that stays in core's `transition`.
- There is no plan hash column because core's `Plan` has no hash yet (page 03 asks for one).
- The database code lives in `db/` and `scripts/db/` because page 01 lists no database package. I05 and I06 will need to import it, so a package may be worth deciding then.
- `pnpm services:up` and `pnpm services:down` need Linux or macOS.
