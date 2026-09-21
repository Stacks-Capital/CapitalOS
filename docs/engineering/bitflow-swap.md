# Certified Bitflow swap routing (K29)

Bitflow exact-input swaps are limited to the allowlisted sBTC↔USDCx pair on `dlmm-swap-router-v-1-2`. Until a live pool principal is pinned in `BITFLOW_ALLOWED_POOLS`, only fixture routes may quote.

## Semantics

- Quote expiry and any change to pool, router or amount-in force a requote. The wallet must not sign a stale route.
- Minimum output is an on-chain argument plus deny-mode post-conditions.
- Slippage is capped at `MAX_SLIPPAGE_BPS` (300). Quotes that request higher slippage or a min-out below that floor fail closed.
- Completion requires a canonical settlement whose amount-out meets min-out and whose pool matches the quote.
- Testnet stays unavailable. Non-fixture live tickers fail closed while the pool list is empty.

## Certification

```sh
pnpm --filter @stacks-capital/adapters test
pnpm adapters:certify
```

The K29 lifecycle fixtures cover expiry, route change, min-out reconciliation failure, testnet unavailability and the unpinned-pool guard. The built-in adapter certification fixture pins the exact swap plan shape.
