# Certified Granite credit lifecycle (K32)

Granite `v0-8-market` is the user credit market: isolated sBTC collateral and USDCx debt. It is not a Zest earn vault and does not copy Zest share-rate assumptions.

## Semantics

- Collateral add/remove, borrow and repay are deny-mode contract calls with enforceable post-conditions.
- `price-feeds` stays `none` only when the quote already proved the oracle fresh (max age 3 minutes). Stale oracles fail closed.
- Repay-all uses protocol **accrued** debt (`settleRepayAmount("max", accrued)`). Overpay is refused.
- Borrow is blocked when collateral is zero, projected LTV exceeds the borrow limit, USDCx liquidity is insufficient, or the debt vault is paused.
- Fixture LTV/buffer values remain labeled as unverified governance parameters until live egroup reads are wired.

## Lifecycle

Stable key: `network + granite + action + idempotency key`. Reloads never set `broadcastAllowed`. States cover unavailable, oracle_stale, paused, liquidity_blocked, health_blocked, awaiting_signature, submitted, confirming, reconciled and reconciliation_failed.

## Certification

```sh
pnpm --filter @stacks-capital/adapters test
pnpm adapters:certify
```

The K32 fixtures cover repay-all against accrued debt, canonical borrow/repay reconciliation, and oracle/pause/liquidity/health boundaries. The built-in adapter certification fixture continues to pin the exact borrow plan shape.
