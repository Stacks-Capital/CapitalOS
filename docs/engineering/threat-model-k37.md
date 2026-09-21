# Transaction and economic threat-model (K37)

| | |
|---|---|
| Tasks | K37 Complete transaction and economic threat-model review |
| Owner / reviewer | Kenzman / IBK |
| Depends on | K34–K36 |
| Date | 2026-09-21 |

Review of signing, allowlists, slippage, oracle, reorg, adapter and tenant boundaries after plan hardening, workflow recovery and risk semantics. Findings are closed in code/tests or listed as explicit launch blocks. Scope stays non-custodial: the host wallet broadcasts; CapitalOS does not operate a pooled discretionary vault.

## Scope and stance

- In-scope writes: sBTC deposit/withdraw, Zest supply/redeem, Granite supply/borrow/repay/withdraw_supply, Bitflow swap.
- Explicitly out: staking lockups (capability disabled), Zest user borrow (redirect to Granite), live Bitflow pools until pinned.
- Non-custodial: `createCapitalOS().submit()` throws; deny-mode post-conditions bind the sender; no CapitalOS custody of keys or pooled strategy vault (`zvstBTC` excluded).

## Control matrix

| Threat | Control | Evidence | Status |
|---|---|---|---|
| Substituted / unbound plan | Quote id, registry, adapter, shared expiry, effects, post-conditions | `validatePlan`, `threat.test.ts`, K34 | Closed |
| Allowlist bypass | Signed registry `allowedContracts` | `signing.test.ts`, certification | Closed |
| Extreme slippage / zero min-out | `MAX_SLIPPAGE_BPS = 300`; floor on min-out | `bitflow/swap.ts`, swapLifecycle + credit-roundtrip tests | Closed |
| Stale oracle / paused vault | Fail-closed quotes | K18 drill, granite/bitflow/zest lifecycle tests | Closed |
| Duplicate / unknown write | `canSubmitWrite` only at sign; unknown → `RETRY_READ` | K35 workflow, threat tests | Closed |
| Reorg | Workflow → `REORGED`, evidence kept | `applyReorgToWorkflow`, failure-drill | Closed |
| Unhealthy collateral remove | Projected health gate + lifecycle | credit-roundtrip + creditLifecycle (K37) | Closed |
| Adapter boundary (Zest ≠ Granite) | `marketsComparable`, Zest credit unavailable | credit-roundtrip, zest creditLifecycle | Closed |
| Tenant leak | Tenant-scoped workflow reads | API integration tests (I05) | Closed (IBK) |
| Staking custody path | Capability disabled | staking lifecycle, failure-drill | Closed |

## Write-path abuse and failure coverage

| Path | Abuse / failure tests |
|---|---|
| sBTC deposit / withdraw | depositLifecycle, withdrawalLifecycle, adapters, earn-roundtrip |
| Zest supply / redeem | earnLifecycle, adapters, earn-roundtrip |
| Granite supply / borrow / repay | credit-roundtrip, creditLifecycle, failure-drill, borrowSafety |
| Granite withdraw_supply | credit-roundtrip + creditLifecycle (healthy plan, CAP_REACHED, ORACLE_STALE, health_blocked) |
| Bitflow swap | swapLifecycle, credit-roundtrip (slippage/min-out abuse) |
| Stake | lifecycle unavailable + capability disabled |

## Findings register

| ID | SEV | Finding | Close criteria | Status |
|---|---|---|---|---|
| K37-H1 | High | Granite `withdraw_supply` lacked abuse/failure tests | Quote/plan/lifecycle tests for healthy, unhealthy, stale | **Closed** |
| K37-M1 | Medium | Bitflow accepted ≤9999 bps slippage / tiny min-out | Cap 300 bps + min-out floor + tests | **Closed** |
| I20-B1 | Launch-block | Ingestion does not advance workflows past `SUBMITTED` | Worker links txs → confirm/reconcile | Open launch-block |
| I20-B3 | Launch-block | Live Granite positions / USDC feed incomplete | DIA USDC + position reads certified | Open launch-block |
| I20-B6 | Launch-block | `BITFLOW_ALLOWED_POOLS` empty | Pin verified pool principal | Open launch-block |
| K02-reclaim | Launch-block | Reclaim material must outlive browser storage | Durable reclaim storage policy | Open launch-block |

No unresolved critical/high **code** findings remain after K37-H1/M1. Remaining highs are explicit production launch blocks, not silent defects.

## Closure commands

```sh
pnpm --filter @stacks-capital/core test
pnpm --filter @stacks-capital/adapters test
pnpm --filter @stacks-capital/fixtures test
pnpm adapters:certify
pnpm sdk:check
```
