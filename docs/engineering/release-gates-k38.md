# Release gates: live protocol, golden-address and failure injection (K38)

| | |
|---|---|
| Tasks | K38 Run live protocol, golden-address and failure-injection gates |
| Owner / reviewer | Kenzman / IBK |
| Depends on | K25–K37, I23 |

Reproducible **sandbox** (default) and optional **mainnet-shadow** matrices. The gate never broadcasts, never funds wallets, and never publishes packages.

## Commands

```sh
pnpm gate:k38                 # sandbox + fixture goldens + failure matrix
pnpm gate:k38 -- --live       # also runs read-only sdk:check:live
pnpm gate:k38 -- --with-restore  # also runs db:restore-drill (needs DATABASE_URL)
```

Evidence is written to `docs/release/evidence/k38-latest.json` and `k38-latest.md` (environment, Node version, registry version, check IDs, golden results, limitations).

## Sandbox matrix

| Check | What it proves |
|---|---|
| `adapters:certify` | Adapter conformance on fixture reads |
| `sdk:check` | SDK validate-only surface against fixtures |
| Fixture earn/credit roundtrips + failure drill | Quote→plan→reconcile without writes |
| Golden-address reconcile | Independent expectations vs adapter/registry |

## Golden addresses

`packages/fixtures/src/goldenAddresses.ts` holds fixture-mode goldens:

- **User** (`fixture-user-granite`): independent position snapshot reconciled against Granite `readPositions` (two sources; not adapter-self-check).
- **Protocol** (Zest vault, Granite market): principals must match the signed registry.

Live Granite position reads remain launch-block **I20-B3**; default gate uses fixtures only.

## Failure injection

| Class | Injection | Recovery |
|---|---|---|
| Provider | Stale oracle | `ORACLE_STALE`, no plan |
| Database | Append-only events; optional `db:restore-drill` | Restore drill when `DATABASE_URL` / `--with-restore` |
| Webhook | Hung / empty confirmation | `BROADCAST_UNKNOWN` → `RETRY_READ` |
| Wallet | Empty txid | `UNKNOWN`; `canSubmitWrite` false |
| Reorg | After `COMPLETED` | `REORGED` / `CONTACT_SUPPORT`; events kept |
| Registry pause | Paused USDCx vault (+ ops CLI when DB up) | `CAPABILITY_DISABLED` |

Full fixture proofs: `packages/fixtures/src/failure-drill.test.ts` (K18 + K38 matrix).

## Limitations recorded in evidence

- No broadcasts; Bitflow live pools unpinned (**I20-B6**).
- Workflows do not advance past `SUBMITTED` without ingestion (**I20-B1**).
- Registry pause CLI requires DB; fixture pause is the default gate proof.
- Webhook outage is semantic (`RETRY_READ`), not a live webhook server.
