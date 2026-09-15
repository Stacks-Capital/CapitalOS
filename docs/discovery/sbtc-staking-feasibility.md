# sBTC and staking feasibility

| | |
|---|---|
| Task | K02 sBTC and staking feasibility spike |
| Requirements | SBTC-01, EARN-01 |
| Owner / reviewer | kenzman / IBK |
| Observed | 2026-09-15 |
| Depends on | I01 provider inventory, I02 wallet feasibility, K01 matrix |

## sBTC deposit

User code does not call `sbtc-deposit`. Signers call `complete-deposit-wrapper`. The product path is:

1. Build an unsigned Bitcoin deposit (amount, Stacks recipient, reclaim script, max signer fee).
2. User signs and broadcasts on the Bitcoin network that matches Stacks (`mainnet` or `regtest` for Stacks testnet — I01).
3. Notify Emily `POST /deposit`.
4. Observe Bitcoin confirmations, signer processing, then a canonical `protocol-mint` on `sbtc-token`.
5. Reconcile the sBTC balance delta.

Completion is mint + reconcile. A Bitcoin txid, Emily `accepted`, or HTTP 200 is not completion.

**Mainnet:** Emily tracks Hiro (I01). `perDepositMinimum` 1000 sats. Leather and Xverse can sign PSBTs (I02). Enabled.

**Testnet:** Disabled. Emily beta does not track `api.testnet.hiro.so` (I01 F2). Leather has no Bitcoin regtest (I02 F1). Xverse Regtest is unverified against Hiro's Stacks-anchored regtest.

Reclaim material must outlive browser storage. Storage policy is still an open threat-model item (architecture §13). Adapters persist the reclaim lock time on the plan (144 blocks) and do not invent a storage backend.

## sBTC withdrawal

User calls `initiate-withdrawal-request(amount, recipient, max-fee)` on `sbtc-withdrawal`. That locks `amount + max-fee` via `protocol-lock`. Dust is 546 sats.

Recipient encoding matches pox-4:

| version | hashbytes | type |
|---|---|---|
| 0x00–0x04 | 20 bytes | P2PKH / P2SH family / P2WPKH |
| 0x05–0x06 | 32 bytes | P2WSH / P2TR |

Signer `accept-withdrawal-request` burns locked sBTC and pays BTC. Reject unlocks. The workflow completes only after signer acceptance **and** the Bitcoin payout transaction. The Stacks request is one step.

`perWithdrawalCap` on Emily mainnet is 50100000000 sats (I01).

## Bitcoin Staking

`pox-5` is deployed on both networks and exposes `stake`, `unstake` and `unstake-sbtc`. That is not enough.

Still unverified: production signing path for L1 lockups, delegation/bond model, capacity, reward source, exit, and whether Leather/Xverse can sign the required Bitcoin lockup on the network Stacks actually uses.

Architecture default: **Not available**, no simulated transaction. Staking uncertainty does not block sBTC Earn. Capability flags keep `stake` disabled on both networks.

## Findings for adapters

1. Deposit plans are `bitcoin_deposit` payloads, never Stacks contract calls.
2. Withdrawal plans are deny-mode `initiate-withdrawal-request` calls. Do not mark COMPLETED at that step.
3. Testnet sBTC bridge actions stay disabled until Kenzman confirms a test environment that matches Hiro (I01 owner note).
4. Staking stays disabled; K16 is a documented exclusion unless new evidence lands.
