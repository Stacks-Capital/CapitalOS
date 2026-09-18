# Market ingestion and projection worker

| | |
|---|---|
| Task | I06 Market ingestion and projection worker |
| Requirements | CAP-01, POS-01, WF-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I04 database, K05 reorg aware ingestion design |
| Date | 2026-09-17 |

Deliverable from the task page: ingest raw data, project snapshots and reconcile reads; stale or missing values produce warnings, not zero.

This slice covers Stacks mainnet. Bitcoin and Emily deposit tracking come with the sBTC deposit flow.

## What one tick does

`tick()` runs the K05 pipeline once, in order:

1. **Blocks.** Read the checkpoint, then follow the chain forward block by block, at most 10 per tick. Each block, its events and the new checkpoint are written in one transaction.
2. **Events.** For every watched contract, read its contract logs, store each as an immutable `raw_events` row, then decode the `action` field into a `canonical_activities` row. Raw payloads are stored before they are interpreted.
3. **Projections.** For every market in the registry with an action that is not disabled, read the contract and write a `market_snapshots` row.
4. **Reconciliation.** Compare the stored projection with the fresh read and write a `reconciliation_runs` row: `match`, `mismatch` or `unavailable`.
5. **Prices.** Read each oracle feed and write a `price_snapshots` row.

A tick never throws in normal operation. A provider failure is recorded as an unknown value with a warning, and the checkpoint stays where it is, so the next tick retries from the same place.

## Reorgs

The checkpoint is `(chain, network, height, hash)`. When the canonical block at the checkpoint height no longer has the checkpoint hash, the worker walks back, at most 50 blocks, until stored evidence and the chain agree. That block is the common ancestor.

Everything above the ancestor is marked noncanonical: blocks, their raw events and their activities. Nothing is deleted. The checkpoint moves down to the ancestor, and the next tick follows the new fork from there. A block that does not continue the chain during a forward walk stops the walk; the next tick rewinds.

## Unknown is never zero

This is the rule the task names, and it is enforced twice.

| Case | Stored as |
|---|---|
| Contract read fails | `available_liquidity` null, `stale` true, warning naming the failure |
| Market has no onchain read for its role | all values null, `stale` true, warning naming the role |
| Oracle feed is empty (price or timestamp is 0) | `price` null, `stale` true, warning |
| Oracle price is older than 30 minutes | price kept, `stale` true, warning with the age |
| Contract really returns 0 | `0`, not stale. A real zero is data |

The database enforces the same thing: `price_snapshots.price` must be greater than zero when present, a row without a value must carry a warning, and an unknown price must be stale. `market_snapshots` already required a warning when liquidity is null (I04).

## Prices without Pyth

Pyth Hermes needs a paid key (I01 blocker). The live Granite market reads prices from an onchain DIA oracle, `SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle`, through a read only `get-value`. That is free through Hiro, needs no key and is the same value the protocol itself uses, so the worker reads it.

Feeds read: `BTC/USD`, `STX/USD`, `sBTC/USD`. Prices are integers with 8 decimals, and `published_at` comes from the feed, so age is measured against the oracle's own timestamp and not our clock.

Measured on 2026-09-17: `BTC/USD` and `STX/USD` were fresh, `sBTC/USD` was 44 days old, and `USDC/USD` was never set (value and timestamp both 0). The first two store a price, the third stores a price marked stale, the fourth stores unknown.

Hermes is still needed for the write path. Granite's `borrow`, `collateral-add` and `liquidate` take a `price-feeds` argument, which is a signed update the caller supplies. That belongs to execution (I07, I08), where a trial key is enough to test.

## Watched markets

The registry in the database decides what is watched. Each market's first action that is not disabled gives the deployment, and the deployment's role decides how it is read.

| Role | Read |
|---|---|
| `earn_vault`, `debt_vault` | `get-total-assets`, `get-available-assets`, `get-cap-supply`, `get-interest-rate`, `get-pause-states` |
| anything else | none yet, so the snapshot is unknown with a warning |

Today that means `zest.sbtc.vault` is projected from reads, while `granite.sbtc.isolated`, `bitflow.sbtc-usdcx`, `sbtc.deposit` and `sbtc.withdraw` are stored as unknown. Those need per asset reads and provider calls that later tasks own.

## Commands and configuration

| Command | What it does |
|---|---|
| `pnpm worker:tick` | Runs one tick and prints a JSON summary |
| `pnpm worker:run` | Runs a tick every `WORKER_INTERVAL_MS`, stops on SIGINT or SIGTERM |

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Same database as the API |
| `HIRO_API_KEY` | optional | Raises Hiro limits from 20 to 40 requests a second (I01). Server side only |
| `WORKER_NETWORK` | `mainnet` | Network to ingest |
| `WORKER_INTERVAL_MS` | `60000` | Delay between ticks, at least 1000 |

## Live evidence

Two ticks against mainnet on 2026-09-17, in a scratch schema (summaries as the worker printed them):

```json
{"tipHeight":9012606,"blocks":1,"events":40,"activities":40,"markets":{"written":5,"stale":4},"prices":{"written":3,"unknown":0},"reconciliation":{"match":0,"mismatch":0,"unavailable":5}}
{"tipHeight":9012614,"blocks":8,"events":0,"activities":0,"markets":{"written":5,"stale":4},"prices":{"written":3,"unknown":0},"reconciliation":{"match":1,"mismatch":0,"unavailable":4}}
```

The second tick followed 8 new blocks, re-read the same events without storing them again, and reconciled its own previous projection. Activities decoded from real logs included `zest.deposit`, `zest.redeem`, `granite.borrow`, `granite.repay`, `granite.collateral-add` and `granite.collateral-remove`. `zest.sbtc.vault` projected 58693265572 available of a 500000000000 cap at rate 130, not paused. `BTC/USD` and `STX/USD` were fresh; `sBTC/USD` stored its price with the warning `sBTC/USD was published 44 days ago`.

A database seeded with the I04 fixtures cannot ingest the live chain: the fixture checkpoint is at a height whose real block has another hash, so the worker refuses with `No common ancestor within 50 blocks`. That is the intended refusal. A live database gets migrations and the registry, not the fixture chain evidence.

## Tests

- Unit (`apps/worker/src/*.test.ts`): Clarity decoding against payloads recorded from mainnet on 2026-09-17, including a pause state tuple, a vault balance, a live DIA price, an empty DIA entry and a real vault deposit event; the Hiro client's key header, rate limit and failure mapping; every rule in the table above for market and price snapshots; and reconciliation match, mismatch and unavailable.
- Integration (`apps/worker/test/integration`), against a migrated and seeded schema with a chain the test controls: bootstrap with no checkpoint, following the chain forward, projecting a vault market and storing everything else as unknown, storing prices, ingesting contract logs once, reconciling match and mismatch, keeping a failed read out of the projection, rewinding a reorg without deleting evidence, marking an orphaned block's events noncanonical, and skipping a transaction the chain no longer holds.

## Findings

1. **Prices are available without Pyth.** See above. This removes the pricing blocker for reads and display. The paid Hermes plan is only needed for writes that carry a price update.
2. **`get-interest-rate` is stored as the supply rate.** The vault returns a single rate in basis points (130 on 2026-09-17, with utilization 1111). Please confirm it is the supply rate and not the borrow rate, and whether the borrow rate needs a different read.
3. **Granite's market has no vault read surface.** `v0-8-market` exposes `oracle-last-update` and pause and risk getters, but no total or available balance, so market level liquidity for `granite.sbtc.isolated` needs per asset reads. It is stored as unknown until then.

## Unsupported and deferred

- Bitcoin and Emily ingestion, so `sbtc.deposit` and `sbtc.withdraw` have no projected values yet.
- Position and wallet balance projections (I11 decodes positions).
- Workflows are not moved by ingestion yet. `canonical_activities.workflow_id` is always null, and the `REORGED` and `RECONCILING` transitions that K05 describes belong to the workflow engine task.
- One worker process only. There is no lease or leader election, so two workers against one database would both ingest. The checkpoint keeps the evidence correct, but the work is duplicated.
- Contract logs are read from the newest page per contract, 20 events at a time. A contract that produces more than 20 events between ticks would leave a gap, which the reconciliation run surfaces but does not repair.
