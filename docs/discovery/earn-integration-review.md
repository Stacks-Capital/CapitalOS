# Earn transaction integration review

| | |
|---|---|
| Task | K10 Earn transaction integration review |
| Requirements | EARN-01, SBTC-01, WF-01 |
| Owner / reviewer | kenzman / IBK |
| Depends on | K07, K08, K09. I10 product UI is not in this slice; review is adapter + workflow evidence. |

## Vertical slice

BTC → sBTC (K07) → Zest supply (K09) → Zest redeem (K09) → sBTC withdrawal request (K08).

Each arrow is its own workflow. Bitcoin and Stacks legs are never one atomic success.

## Evidence

`pnpm test:e2e` walks the slice on sandbox reads taken from K01 live measurements (Emily limits, vault caps, 1:1 share preview when the vault reports a 1:1 rate).

| Step | Adapter | Plan kind | Complete when |
|---|---|---|---|
| Deposit | `sbtc-deposit@0.1.0` | `bitcoin_deposit` | canonical mint + balance reconcile |
| Supply | `zest-earn@0.1.0` | `deposit` on `v0-vault-sbtc`, deny-mode | vault position + receipt supply |
| Redeem | `zest-earn@0.1.0` | `redeem`, min-out onchain | sBTC back, no double-counted zsBTC |
| Withdraw | `sbtc-withdraw@0.1.0` | `initiate-withdrawal-request` | signer accept **and** BTC payout — not the Stacks tx |

## Checks that passed in this review

- Quote is not a signature. Plan binds quote, network, registry and adapter versions.
- JavaScript numbers cannot enter amount or post-condition arithmetic.
- Testnet sBTC deposit and all staking actions are capability-disabled rather than mocked.
- Empty wallet `txid` maps to `BROADCAST_UNKNOWN` / `RETRY_READ`, not another write.
- Completed workflows can re-enter `REORGED`.
- zsBTC is disclosed as the supplied claim, not extra portfolio value.

## Still owned elsewhere

- I10 Earn review UI and progress drawer.
- I05 persistence of workflows.
- Live Bitcoin broadcast and Emily `POST /deposit` (blocked on testnet; mainnet needs funded accounts and is not part of this review).
- Pyth key / Lazer updates for live borrow health. K12/K14 now have fail-closed fixture oracles; see `docs/discovery/credit-swap-risk.md`.
