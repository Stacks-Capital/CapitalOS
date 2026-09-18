# Capital OS docs

## Start here

- [Quickstart](guides/quickstart.md): from a fresh clone to everything running locally.
- [API errors](reference/api-errors.md): every error code, its status, and what to do. Generated from the code.
- [Embedding](engineering/embedding.md): the browser packages, widgets and the partner example.
- [Adapter guide](guides/adapter-guide.md): adding a protocol or an action.

## Operating it

- [Incident runbook](runbooks/incidents.md): symptoms, first actions, and when to escalate.
- [Backup and restore](runbooks/backup-restore.md): the procedure and the drill that proves it.
- [Rollback](runbooks/rollback.md): going back to the previous release, and the drill that proves it is safe.
- [Metrics, alerts and feature flags](engineering/operations.md): what is measured and the operator switches.

## Release

- [Pilot and release checklist](release/pilot-checklist.md): evidence, manual checks and outstanding issues for the go/no-go.

## How it is built

`engineering/` has one document per task: the API, database, ingestion, SDK client, web app, positions, earn comparison, borrow, swap, risk and activity, browser tests, monorepo and CI.

## Research

`discovery/` has the protocol, provider and wallet research, the threat model and the failure injection drill that the build rests on.
