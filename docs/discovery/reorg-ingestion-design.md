# Reorg-aware ingestion design

| | |
|---|---|
| Task | K05 Reorg-aware ingestion design |
| Requirements | OPS-01 |
| Owner / reviewer | kenzman / IBK |
| Implements later | I06 Market ingestion and projection worker |

K05 is the contract I06 must implement against. It does not add Postgres, Redis or the worker process. Those belong to IBK (I04/I06).

## Invariants

- Onchain state is financial truth. Platform state is an evidence-backed projection.
- Raw payloads are stored before they are interpreted.
- Events are never deleted on reorg. They are marked noncanonical.
- Decode uses the exact deployment revision from the capability registry.
- A completed workflow may re-enter `REORGED` then `RECONCILING` until new canonical evidence stabilizes.
- Uncertain writes are inspected (`RETRY_READ`). They are never blindly resubmitted.

## Pipeline

1. Fetch blocks/events with provider identity (`hiro`, `mempool`, `emily`) and a checkpoint.
2. Append immutable `raw_events`.
3. Decode with the adapter revision pinned on the market (`decodeEvents`).
4. Project canonical activity, balances and positions.
5. Compare projections with direct contract reads (`reconcile`).
6. Serve `DataPoint` values with `stale`, `source`, time and optional block hash. Never coerce unknown to zero.

## Checkpoint and rewind

`packages/core` exposes `applyBlock` and `applyReorg`.

- Checkpoint is `(chain, network, height, hash)`.
- A new block must parent the checkpoint hash.
- `applyReorg(commonAncestorHash)` marks later blocks and events noncanonical and moves the checkpoint to the ancestor.
- Affected workflows transition to `REORGED`. Next action is `CONTACT_SUPPORT` until a fresh read moves them to `RECONCILING`.

## Entity map for I06

| Domain | Entities |
|---|---|
| Registry | protocols, deployments, assets, capabilities, markets, adapter_releases |
| Chain evidence | chain_blocks, raw_events, ingestion_checkpoints, canonical_activities, reconciliation_runs |
| Projections | balance, position, price, rate, liquidity, reward snapshots, cash_flows |
| Execution | quotes, plans, workflows, steps, transaction_attempts, transitions, recovery_actions |

I06 should persist these. The in-memory engine in `@stacks-capital/core` is the behavior spec and the unit-tested rewind.

## Provider notes from I01

- Hiro mainnet `/extended` is cached ~3s. Bypass cache when recording checkpoints.
- Testnet has a single Stacks provider.
- Emily pagination is `pageSize` + `nextToken`.
- Bitflow ticker is last-24h only and latency is unstable; mark stale rather than blocking safe exits.
