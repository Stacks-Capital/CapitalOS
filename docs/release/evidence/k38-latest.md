# K38 gate evidence

| | |
|---|---|
| Generated | 2026-09-22T14:51:34.600Z |
| Mode | sandbox |
| Registry | 0.1.0 |
| Node | v24.21.0 |
| Result | **PASS** |

## Checks

| Category | ID | Result | Detail |
|---|---|---|---|
| sandbox | adapters:certify | pass | pass |
| sandbox | sdk:check | pass | pass |
| sandbox | fixture-e2e-matrix | pass | pass |
| golden | golden:fixture-user-granite | pass | matched via golden-fixture; registry 0.1.0 |
| golden | golden:protocol-zest-vault | pass | matched via signed-registry; registry 0.1.0 |
| golden | golden:protocol-granite-market | pass | matched via signed-registry; registry 0.1.0 |
| golden | golden:all-matched | pass | 3/3 addresses |
| failure | failure-injection | pass | pass |
| ops | db:restore-drill | pass | skipped (set DATABASE_URL or pass --with-restore) |
| ops | registry-pause-drill | pass | fixture equivalent covered by failure-drill paused vault + ops:pause CLI when DB is up |
| mainnet-shadow | sdk:check:live | pass | skipped (pass --live for read-only provider probes) |

## Golden addresses

| ID | Matched | Source | Mismatches |
|---|---|---|---|
| fixture-user-granite | true | golden-fixture | — |
| protocol-zest-vault | true | signed-registry | — |
| protocol-granite-market | true | signed-registry | — |

## Limitations

- Gate never broadcasts or funds wallets.
- Golden addresses in default mode use fixture snapshots; live Granite positions remain launch-block I20-B3.
- Bitflow live pools unpinned (I20-B6). Workflows do not advance past SUBMITTED without ingestion (I20-B1).
- Registry pause CLI requires DATABASE_URL; fixture pause coverage is the default gate.
- Webhook provider outage is covered as BROADCAST_UNKNOWN / RETRY_READ semantics, not a live webhook server.

## Commands

```sh
pnpm gate:k38
pnpm gate:k38 -- --live
pnpm gate:k38 -- --with-restore
```
