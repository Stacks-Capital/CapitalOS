# Metrics, alerts and feature flags

| | |
|---|---|
| Task | I17 Metrics, alerts and feature flags |
| Requirements | OPS-01, PMF-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I15 risk and activity, K14 protocol risk arithmetic |
| Date | 2026-09-18 |

Deliverable from the task page: instrument lag, quote failures and stuck workflows; deduplicate alerts and allow per capability disablement.

## Metrics

Everything is computed from the database (migration `0009_ops.sql`), so every API and worker instance sees the same numbers.

| Metric | Recorded by | How it is read |
|---|---|---|
| Ingestion lag | The worker, each tick: blocks between the chain tip and the checkpoint | Latest `ingestion_tick` event |
| Ingestion stopped | The checkpoint's own update time, and failed ticks | `ingestion_checkpoints.updated_at`, `ingestion_failed` events |
| Quote failures | The API, on every quote attempt, with the error code | `quote_succeeded` and `quote_failed` events per market in a 15 minute window |
| Stuck workflows | Nothing extra: how long a workflow has sat in its state | `workflows.updated_at` against a limit per state |

Stuck limits: 30 minutes awaiting a signature, 60 minutes submitted, confirming or reconciling, and immediately for `BROADCAST_UNKNOWN`, `REORGED` and `MANUAL_REVIEW`, because nothing about those fixes itself.

A failure to record a metric never fails the request it describes: a lost event costs a count, not a user's quote.

## Alerts

| Alert | Warning | Critical |
|---|---|---|
| `ingestion_lag` | 30 blocks behind | 120 blocks behind |
| `ingestion_failing` | | Checkpoint unmoved for 10 minutes, or 3 failed ticks in the window |
| `quote_failures` (per market) | 20% of at least 5 attempts failed | 50% failed |
| `workflow_stuck` (per workflow) | Past its limit | Past its limit in a state only a person can resolve |

**Deduplication.** Each alert has a key that names the problem, not the moment (`quote_failures:mainnet:zest.sbtc.vault`). A problem seen again updates its open alert, counting occurrences, instead of opening another. The database enforces this with a unique index on open alerts per key. A notification is printed only when an alert opens or resolves, so a problem that lasts an hour produces two lines, not sixty. When a resolved problem returns, a new alert opens, so the history shows both episodes.

The worker evaluates alerts after every tick. Notifications are JSON lines on standard output, ready for whatever collects the worker's logs.

## Switching a capability off

```bash
pnpm ops:disable mainnet zest.sbtc.vault supply "vault under maintenance"
pnpm ops:pause   mainnet bitflow.sbtc-usdcx swap "pool liquidity too thin"
pnpm ops:enable  mainnet zest.sbtc.vault supply
pnpm ops:status  mainnet
```

An override takes effect on the next request, with no deploy:

- Market lists, capability lists and earn options show the new state with the reason, prefixed "Switched off by an operator".
- `POST /v1/quotes` and `POST /v1/plans` refuse with `CAPABILITY_DISABLED`.
- `POST /v1/workflows` refuses too, so a quote made before the switch cannot start a workflow after it.
- The worker keeps projecting the market, so monitoring continues while trading is off.

**An override can only make a capability stricter.** The `effective_capabilities` view takes the stricter of the registry and the override, so an operator can switch something off but never switch on what the registry disables. `ops:enable` only removes the override.

A reason is required, because it is shown to users. The operator's name comes from `OPERATOR`, or the shell user.

## Tests

- `apps/worker/src/alerts.test.ts` (10): nothing raised when healthy, lag warning and critical, a stopped checkpoint, repeated tick failures, too few quote attempts to judge, one alert per market with its codes, one alert per stuck workflow with the right severity, keys stable over time and separate per network, and thresholds taken from configuration.
- `apps/worker/test/integration/ops.test.ts` (4): metrics computed from recorded events, each problem opened once with occurrences counted and no repeat notification, a cleared problem resolved and a returning one reopened as a new alert, and the database refusing a second open alert for a key.
- `apps/api/test/integration/execution.test.ts`: every quote attempt counted with its code, a switched off capability refused for quotes and new workflows and shown with its reason in market lists, restored after `ops:enable`, and an override unable to loosen a capability the registry disables.

## Unsupported and deferred

- Notifications go to standard output only. Paging or chat delivery needs a destination chosen by whoever runs the service.
- No metrics endpoint: `ops:status` reads the database directly. Exposing metrics over HTTP needs an operator credential, which does not exist yet.
- Thresholds are code defaults. Making them per deployment configuration belongs with the release checklist (I20).
- Overrides have no expiry. A switch stays until someone removes it, which is the safe default.
