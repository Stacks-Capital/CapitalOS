# Failure injection and recovery drill

| | |
|---|---|
| Task | K18 Failure injection and recovery drill |
| Requirements | WF-01, OPS-01 |
| Owner / reviewer | kenzman / IBK |
| Depends on | K17 threat-model review. I17 metrics/alerts/flags are not in this slice. |
| Date | 2026-09-18 |

Architecture §21 fault injection: provider lag, reorg, signer delay, quote expiry and transaction abort. Duplicate webhook is I17/I05, not invented here.

## Drill

`pnpm test:e2e` includes `packages/fixtures/src/failure-drill.test.ts`.

| Injection | Observed recovery |
|---|---|
| Stale Granite oracle | `ORACLE_STALE`. No executable plan. |
| Paused USDCx vault | `CAPABILITY_DISABLED`. Borrow stays off. |
| Quote past expiry | `assertValidPlan` refuses. Wallet is not asked. |
| Empty txid / hung wallet | `BROADCAST_UNKNOWN` / `RETRY_READ`. A second `SUBMITTED` transition is rejected. |
| Canonical reorg after complete | `REORGED` / `CONTACT_SUPPORT`. Events are not deleted (K05). |
| Collateral confirmed, borrow refused | `ACTION_REQUIRED` / `FOLLOW_UP`. Workflow is not `FAILED`. |
| Unverified stake or testnet sBTC deposit | Capability disabled. No simulated transaction. |

Signer delay for sBTC deposit stays pending until a canonical mint reconciles (K07/K10). That path is not completed by a Bitcoin txid alone.

## Not in this drill

I17 (metrics, alerts, feature flags) has since landed. How its alerts and switches map to these failures is in `docs/runbooks/incidents.md`.
