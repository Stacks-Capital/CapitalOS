# Transaction threat-model review

| | |
|---|---|
| Task | K17 Transaction threat-model review |
| Requirements | SEC-01, WF-01, CAP-01 |
| Owner / reviewer | kenzman / IBK |
| Depends on | K10 earn review, K15 borrow UX safety, K16 staking exclusion |
| Date | 2026-09-18 |

Architecture §20. This is a review of controls that already have to hold before a wallet signs. It does not add a new protocol adapter.

## Threats and evidence

| Threat | Control | Evidence |
|---|---|---|
| Malicious or substituted plan | Plan is bound to quote id, adapter version and registry version. Deny-mode post conditions required. | `validatePlan`; `packages/core/src/threat.test.ts` |
| Duplicate financial action | Idempotent workflow start. `canSubmitWrite` only in `AWAITING_SIGNATURE`. Unknown broadcast is `RETRY_READ`, never another write. | `allowsWriteRetry(BROADCAST_UNKNOWN) === false`; K10 empty-txid test |
| Network or asset confusion | Explicit network, Stacks address prefix, Bitcoin network mapped to Stacks, SIP-010 asset ids. | `validatePlan` network/sender checks; K01 registry |
| Stale oracle, rate or liquidity | Adapter thresholds, `ORACLE_STALE`, paused vault, unknown position fail closed. | K14, K15, K18 drill |
| Cross-tenant leak | Tenant-scoped workflow reads (I05). Not re-implemented here. | I05 API tests |
| Partner secret in browser | Client throws if an API key is passed in a window. | I07 client tests |
| Registry compromise | Capability-disabled actions stay off, including stake. | K16 exclusion; `capabilityFor("stake")` |
| Blind retry after hang | `walletOutcome` without a txid is `UNKNOWN` → `BROADCAST_UNKNOWN`. | K10, K18 |

## K16

Staking remains capability-disabled. No lockup-signing path is exposed. That exclusion is the control.

## Still owned elsewhere

- Webhook HMAC/replay (no partner webhooks in this slice).
- Signed registry releases and emergency disable tooling.
- I17 feature flags for turning a new action off while leaving reads and exits up.
