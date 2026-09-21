# Workflow recovery and reconciliation (K35)

| | |
|---|---|
| Tasks | K35 Harden workflow idempotency, recovery and reconciliation |
| Owner / reviewer | Kenzman / IBK |
| Depends on | K34, I22 |

Every financial write is a durable workflow. Transitions append evidence; reload resumes from the recorded state; completion requires a matched canonical position read. Uncertain broadcasts never reopen a write.

## State and next action

`transition` persists `{ from, to, reason, actor, evidence, at }` and recomputes `nextAction`. Helpers below are the only supported post-sign moves for partners and workers.

| Helper | Effect |
|---|---|
| `recordRejection` | `AWAITING_SIGNATURE` → `USER_REJECTED` (`START_NEW`) |
| `recordBroadcast` | → `SUBMITTED` with a non-empty txid |
| `recordUnknownBroadcast` | → `BROADCAST_UNKNOWN` (`RETRY_READ`) — write closed |
| `resolveUnknownBroadcast` | found txid → `SUBMITTED`; absent → `MANUAL_REVIEW` — never back to `AWAITING_SIGNATURE` |
| `beginConfirming` / `markStepConfirmed` / `beginReconciling` | confirmation spine |
| `completeFromReconciliation` | `COMPLETED` only when `matched`; mismatch → `ACTION_REQUIRED` (`CONTACT_SUPPORT`) |
| `recordProviderOutage` | keeps wait state, sets `RETRY_READ`, never reopens a write |
| `applyReorg` / `resumeAfterReorg` | → `REORGED` then `RECONCILING` by reading, not rewriting |
| `resumeHint` | reload guidance for every wait/sign state |

`STEP_CONFIRMED` cannot jump to `COMPLETED`. Reconciliation is mandatory.

## SDK

```ts
flow = os.recordPlan(flow, plan, quote, { sender });
flow = os.recordBroadcast(flow, txid);
flow = os.beginConfirming(flow, "mempool");
flow = os.markStepConfirmed(flow, blockHash);
flow = os.completeFromReconciliation(flow, { matched: true, evidence: "delta" });
os.resumeHint(flow); // { resumable, canSign, canRetryRead, ... }
```

`submit()` remains forbidden. Persistence of the workflow object is the API/database (I22); this package owns the pure state machine.

## Tests

```sh
pnpm --filter @stacks-capital/core test
pnpm --filter @stacks-capital/sdk test
pnpm --filter @stacks-capital/fixtures test
pnpm sdk:check
```
