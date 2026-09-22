# Certified sBTC withdrawal lifecycle (K26)

Stacks Capital separates the Stacks request, signer status, canonical sBTC accounting and Bitcoin payout. The Stacks transaction is never presented as a completed withdrawal. Completion requires an accepted canonical registry request, its canonical completion event, and the exact canonical Bitcoin output.

## Accounting shown to the user

- `withdrawal amount`: the exact BTC output requested and expected at the destination.
- `maximum signer fee`: the fee ceiling selected before signing.
- `initially locked`: withdrawal amount plus maximum signer fee.
- `actual signer fee`: the fee in the canonical acceptance event.
- `final sBTC debit`: withdrawal amount plus actual signer fee.
- `refunded sBTC`: unused maximum fee returned atomically by the withdrawal contract.
- `Bitcoin received`: the independently observed output amount, shown only after exact reconciliation.

If signers reject the request, the lifecycle remains incomplete until the canonical registry status records rejection. That transaction unlocks the entire initially locked amount atomically. An Emily `failed` response alone is therefore shown as `signer_rejection_pending`, not as recovered funds.

## Resume and failure behavior

The stable key is `network + request id`. All inputs are JSON-safe strings and records, so the lifecycle can be rebuilt from the persisted workflow, plan, request id and canonical observations after a reload. Polling never permits a second broadcast. Provider timeouts keep the existing request pending; contradictory evidence fails closed for investigation.

The tenant-scoped `GET /v1/workflows` now includes the quote action, allowing IBK's screen to find a prior `withdraw_sbtc` workflow after reload. `GET /v1/workflows/{id}` returns the action and persisted wallet attempts (step, chain, outcome, txid, timestamp). This is enough to display the exact Stacks transaction and distinguish a known broadcast from `BROADCAST_UNKNOWN`. An attempt is only a wallet response, never proof of an accepted sBTC withdrawal or Bitcoin payout.

I33 handoff: list the signed-in owner's workflows with `network`, select `action === "withdraw_sbtc"`, then read the chosen workflow by ID. If its attempt is `BROADCAST`, link its `txid` to the Stacks explorer and label it "withdrawal request submitted; awaiting on-chain request evidence." If the workflow is `BROADCAST_UNKNOWN` or its attempt has no txid, show an investigation state and do not offer an automatic second broadcast. Keep the workflow ID in navigation state, but use the API list on reload so clearing browser storage does not lose the journey. Never derive a Bitcoin payout amount or a completion badge from the wallet attempt.

The K26 adapter certifies the parsing and reconciliation model, not a live end-to-end withdrawal tracker. The API/worker still does not ingest the canonical request ID, canonical completion, or an independent Bitcoin output into a persisted withdrawal record; callers must not present the model as automatically monitored or production-certified until that wiring and a real cross-chain recovery drill are complete. For I33, show "awaiting request evidence" after broadcast, not "BTC sent".

Expected fulfillment txids and heights from Emily are labeled as estimates and do not drive completion because the public schema says they can change through replacement. The final fulfillment, canonical completion event and Bitcoin output must agree on transaction, output, block and fee.

Testnet currently returns an explicit unavailable state because its signed capability record is disabled; Stacks Capital does not silently substitute mainnet or invent a signer path.

## Certification

Run:

```sh
pnpm --filter @stacks-capital/adapters test
pnpm adapters:certify
```

The K26 fixtures cover recipient-script construction, strict Emily parsing, signer delay and timeout, exact fee/refund/debit accounting, canonical payout reconciliation, mismatched evidence, signer rejection recovery, reload reconstruction and unsupported-environment behavior.
