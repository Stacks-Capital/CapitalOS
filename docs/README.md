# Stacks Capital docs

## Start here

- [Quickstart](guides/quickstart.md): from a fresh clone to everything running locally.
- [API errors](reference/api-errors.md): every error code, its status, and what to do. Generated from the code.
- [Embedding](engineering/embedding.md): the browser packages, widgets and the partner example.
- [Adapter guide](guides/adapter-guide.md): adding a protocol or an action.
- [Signed registry](engineering/signed-registry.md): reviewed contracts, signature verification, safe-exit-only mode and rollback.
- [Adapter certification](engineering/adapter-certification.md): exact read, quote, plan, event and reconciliation conformance.
- [sBTC deposit certification](engineering/sbtc-deposit.md): Bitcoin, signer, mint and reclaim lifecycle evidence.
- [sBTC withdrawal certification](engineering/sbtc-withdrawal.md): request, signer, fee refund and Bitcoin payout reconciliation.
- [Zest earn certification](engineering/zest-earn.md): supply, redeem, APR semantics and receipt valuation.
- [Zest credit availability](engineering/zest-credit.md): why Zest has no user borrow path and where Granite takes over.
- [Granite credit certification](engineering/granite-credit.md): collateral, borrow, repay-all and oracle boundaries.
- [Bitflow swap certification](engineering/bitflow-swap.md): exact-input routing, expiry and min-out reconciliation.
- [Staking routes](engineering/staking-routes.md): why native PoX staking stays unavailable.
- [Plan hardening](engineering/plan-hardening.md): quote/plan binding, exact arithmetic and the wallet validation gate.
- [Workflow recovery](engineering/workflow-recovery.md): idempotent transitions, rejection, outage, reorg and reconciliation-gated completion.
- [Risk engine](engineering/risk-engine.md): Granite health interpretation, stress scenarios, concentration and protective actions.
- [Threat model K37](engineering/threat-model-k37.md): signing, slippage, oracle, reorg and write-path abuse coverage with launch blocks.
- [Release gates K38](engineering/release-gates-k38.md): sandbox/mainnet-shadow matrices, golden-address reconcile, failure injection and evidence.
- [SDK release K39](engineering/sdk-release-k39.md): 0.1.0 release-candidate pack, clean-install and partner compatibility (no registry publish).
- [SDK migration 0.1](guides/sdk-migration-0.1.md): breaking changes and supported Node/React/wallet combinations.

## Operating it

- [Incident runbook](runbooks/incidents.md): symptoms, first actions, and when to escalate.
- [Backup and restore](runbooks/backup-restore.md): the procedure and the drill that proves it.
- [Rollback](runbooks/rollback.md): going back to the previous release, and the drill that proves it is safe.
- [Metrics, alerts and feature flags](engineering/operations.md): what is measured and the operator switches.

## Release

- [Pilot and release checklist](release/pilot-checklist.md): evidence, manual checks and outstanding issues for the go/no-go.
- [Launch decision](release/launch-decision.md): K20/K40 go/no-go, named ownership, rollback triggers. Production is no-go; sandbox certifies Zest supply only.

## How it is built

`engineering/` has one document per task: the API, database, ingestion, SDK client, web app, positions, earn comparison, borrow, swap, risk and activity, browser tests, monorepo and CI.

## Research

`discovery/` has the protocol, provider and wallet research, the threat model, the failure injection drill and the SDK compatibility gate that the build rests on.
