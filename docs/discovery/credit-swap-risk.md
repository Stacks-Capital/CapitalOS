# Credit, swap and risk review

| | |
|---|---|
| Task | K11 Granite isolated collateral, K12 borrow/repay, K13 Bitflow swap, K14 health/LTV |
| Requirements | EARN-01 (normalization), credit/borrow, swap allowlist, fail-closed risk |
| Owner / reviewer | kenzman / IBK |
| Depends on | K03 adapter contract, K04 signing, K09 Zest earn (must not be conflated) |
| Observed | 2026-09-15, Stacks mainnet ABIs |

## Product split

Zest `v0-vault-sbtc` remains the earn market: deposit/redeem receipt shares (`zsBTC`). Granite isolated credit is a different market on `v0-8-market`. `marketsComparable` is false across those protocols even when both actions are `supply`.

Collateral on Granite is locked sBTC. It is not lent out and is not a second portfolio asset the way a wallet balance would be. zsBTC must never be summed with that collateral.

## K11 / K12 Granite

Live ABI on `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market` (height 8883545):

| Action | Method | Args | Post-condition |
|---|---|---|---|
| Add collateral | `collateral-add` | `ft`, `amount`, `price-feeds?` | deny-mode `send_lte` sBTC |
| Remove collateral | `collateral-remove` | `ft`, `amount`, `receiver?`, `price-feeds?` | `receive_gte` sBTC |
| Borrow | `borrow` | `ft`, `amount`, `receiver?`, `price-feeds?` | `receive_gte` USDCx |
| Repay | `repay` | `ft`, `amount`, `on-behalf-of?` | `send_lte` USDCx |

`price-feeds` is planned as `none` only when the quote already proved the oracle fresh (max age 3 minutes). Hermes/Lazer update bytes are not invented; I01 still has no Pyth key. A stale oracle fails closed with `ORACLE_STALE`.

`v0-4-market` stays superseded. `v0-vault-usdc` (height 6162068, USDCx underlying, zUSDC 6 decimals) is liquidity for borrow, not an earn adapter.

A borrow intent may include `collateralAmount` to emit a two-step plan (`collateral-add` then `borrow`).

Fixture risk params used until governance reads are wired: borrow LTV 7000 bps, liquidation LTV 8000 bps, buffer 500 bps.

## K13 Bitflow

Executable router: `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2` (height 6979616).

Plans call `swap-x-for-y-simple-range-multi` or `swap-y-for-x-simple-range-multi` with `max-steps` 8 and `deadline-time` none. `min-out` is an onchain argument plus deny-mode `send_lte` / `receive_gte`. Default slippage 50 bps, rounded down.

`dlmm-swap-router-v-1-1` is superseded. Testnet is disabled (no ticker). The live sBTC/USDCx pool principal is **not pinned**; `BITFLOW_ALLOWED_POOLS` is empty, so only fixture `source: "fixture"` routes quote. A stale ticker/route fails closed.

## K14 Risk

`packages/core/src/risk.ts` uses bigint only. USD notionals are scale-8. Collateral value rounds down, debt rounds up. Health factor is `(collateralUsd * ltvLiqBps) / debtUsd`. Max borrow applies LTV then the buffer. Oracle age > 180000 ms or `stale: true` yields no executable quote. Buffer breaches are advisory alerts, not a second write.

## Evidence

`pnpm test:e2e` (`packages/fixtures/src/credit-roundtrip.test.ts`) plus `packages/core/src/risk.test.ts`.

## Still owned elsewhere

- Live Pyth Hermes key / Lazer `price-feeds` bytes.
- Pinning a verified Bitflow sBTC/USDCx pool principal.
- Live governance LTV reads from egroup/assets.
- I10 credit/swap UI.
