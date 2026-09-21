# Certified Zest supply and withdrawal lifecycle (K27)

CapitalOS treats zsBTC as a receipt claim on supplied sBTC. A supply or redeem is complete only when a canonical vault settlement matches the intended asset and share deltas, including the on-chain min-out bound.

## Reads and APR semantics

- Vault evidence comes from `get-total-assets`, `get-available-assets`, `get-cap-supply`, `get-pause-states`, `get-interest-rate`, and a share preview (`convert-to-shares` / share-rate sample).
- `get-interest-rate` is shown as protocol basis points with scale 4. Capital OS does not annualise, compound, or invent APY from that value.
- A missing rate disables earn ranking and projected-earnings displays. A missing share rate leaves the underlying claim unknown rather than guessing one.

## Receipt valuation

- Portfolio totals count the underlying supplied position once.
- The zsBTC SIP-010 balance is evidence of the claim and never adds a second sBTC total.
- Share↔asset conversion always rounds down, matching the vault's on-chain min-out.

## Lifecycle states

`unavailable` covers disabled capabilities (including public Stacks testnet) and missing market evidence. `paused` and `cap_blocked` refuse new writes. `awaiting_signature` / `submitted` / `confirming` remain incomplete. `reconciled` requires a canonical deposit or redeem event whose assets and shares match the intent. Any mismatch becomes `reconciliation_failed` for support, not a blind retry.

The stable key is `network + zest + action + idempotency key`. Reload reconstruction never sets `broadcastAllowed`.

## Certification

Run:

```sh
pnpm --filter @stacks-capital/adapters test
pnpm adapters:certify
```

The K27 fixtures cover supply and redeem quote/plan/post-condition conformance, floor share conversion, APR disclosure, pause/cap/testnet fail-closed paths, exact canonical reconciliation, mismatched share mint rejection, redeem below min-out rejection, and receipt non-double-counting. Live provider responses are not relabeled as independent certification evidence.

Primary interfaces: deployed `v0-vault-sbtc` (`deposit` / `redeem`) and the signed registry capability rows for Zest supply and withdraw_supply on mainnet.
