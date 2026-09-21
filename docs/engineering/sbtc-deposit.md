# Certified sBTC deposit lifecycle (K25)

CapitalOS treats a BTC transaction, Emily signer status, and a canonical sBTC mint as three different facts. A deposit is complete only when the canonical `completed-deposit` evidence matches the exact Bitcoin txid, output index, recipient, and a minted amount within the signed maximum-fee bound.

## Evidence and states

- The Bitcoin observer supplies canonicality, tip height, and confirmations.
- Public Emily `GET /deposit/{txid}/{index}` supplies `pending`, `accepted`, `confirmed`, `failed`, or `rbf`, plus the absolute reclaim lock height and maximum signer fee.
- The signed registry pins `sbtc-deposit`, `sbtc-registry`, and `sbtc-token` contract deployments.
- A canonical Stacks mint supplies the final output amount and makes the actual signer fee calculable as deposit sats minus minted sats.

`submitted`, `confirming`, `signer_processing`, and `mint_pending` remain incomplete. `reclaimable` appears only when the observed Bitcoin tip reaches Emily's lock height and no canonical mint exists. `reconciled` requires exact matching evidence. Any identity or amount mismatch becomes `reconciliation_failed` and requires support rather than being guessed through.

## Duplicate-transfer safety

The lifecycle key is `network + bitcoin txid + output index`. The watcher is read-only and always returns `broadcastAllowed: false`; a provider timeout keeps the existing transfer pending. The API also records Bitcoin deposit attempts as Bitcoin—not Stacks—and database workflow idempotency prevents a repeated request from creating a second workflow.

## Certification

Run:

```sh
pnpm --filter @stacks-capital/adapters test
pnpm adapters:certify
```

The deterministic K25 fixtures cover notification metadata, signer/confirmation/fee/reclaim exposure, exact canonical reconciliation, mismatched mint rejection, reclaim maturity, timeout idempotency, and strict Emily response parsing. No live provider response is relabeled as independent evidence.

Primary interfaces: the public Emily OpenAPI specification and the deployed `sbtc-registry` `get-completed-deposit`/`completed-deposit` contract record.
