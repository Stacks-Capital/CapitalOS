# Backup and restore

How to back up the Stacks Capital database, restore it, and prove the procedure works. Commands assume the Docker Compose setup from the [quickstart](../guides/quickstart.md). For a managed Postgres, run the same `pg_dump` and `pg_restore` against its connection string.

## What needs a backup

Only Postgres. Redis holds rate limit counters and nothing else, so losing it costs a reset window, not data.

| Data | Tables | If lost |
|---|---|---|
| Identity | `partners`, `partner_apps`, `allowed_origins`, `api_keys`, `user_sessions`, `auth_nonces` | Irreplaceable. Partners lose access and users are signed out |
| Workflows | `quotes`, `plans`, `workflows`, `workflow_steps`, `transaction_attempts`, `state_transitions` | Irreplaceable. The record of what users signed and where each action stands |
| Operator state | `capability_overrides`, `alerts` | Overrides are safety switches. Losing one silently turns a capability back on |
| Registry | `protocols`, `deployments`, `assets`, `markets`, `capabilities` | Rebuilt from config with `pnpm fixtures:seed` |
| Chain evidence and projections | `chain_blocks`, `raw_events`, `ingestion_checkpoints`, `canonical_activities`, the `*_snapshots` tables, `reconciliation_runs` | Rebuilt by the worker from the chain, slowly |
| Metrics | `ops_events` | History only. Alerts start again from the next tick |
| Migrations | `schema_migrations` | Must match the migration files, checked on restore |

Secrets are not in a backup in usable form. API keys and sessions are stored as SHA-256 hashes only, so a leaked backup does not leak a working key. A backup still holds user addresses and workflow history: store it encrypted, with the same access rules as the database.

## Back up

```bash
mkdir -p ~/stacks-capital-backups
docker compose --env-file .env.local exec -T postgres \
  pg_dump -U stacks_capital -d stacks_capital -Fc > ~/stacks-capital-backups/stacks-capital-$(date -u +%Y%m%dT%H%MZ).dump
```

- `-Fc` is the custom format: compressed, and `pg_restore` can restore it selectively.
- `pg_dump` takes a consistent snapshot, so the API and worker can keep running.
- Keep backups outside the repository. Note the time: anything after it is not in this backup.

Check it is readable:

```bash
docker compose --env-file .env.local exec -T postgres pg_restore --list < ~/stacks-capital-backups/<file>.dump | head
```

## Restore

1. Stop the API and the worker, so nothing writes during the restore.
2. Restore over the existing database:

   ```bash
   docker compose --env-file .env.local exec -T postgres \
     pg_restore -U stacks_capital -d stacks_capital --clean --if-exists --no-owner --exit-on-error < ~/stacks-capital-backups/<file>.dump
   ```

   On an empty database (a new volume), leave out `--clean --if-exists`.
3. Check the schema matches the code. Nothing should be applied, and a checksum mismatch stops it:

   ```bash
   pnpm db:migrate
   ```

4. Check the operator switches. A backup older than the last `ops:disable` does not have it:

   ```bash
   pnpm ops:status mainnet
   ```

   Apply again any override that was set after the backup time.
5. Revoke any API key that was revoked after the backup time, with `pnpm keys:revoke`. The restored row is active again.
6. Start the API and the worker. The worker continues from the restored checkpoint and catches up with the chain; lag alerts clear once it has.
7. Review workflows created between the backup time and the failure. They are not in the database, but their transactions may be on chain. Treat that window as an incident (see [incidents](incidents.md)).

## Prove it

```bash
pnpm db:restore-drill
```

`packages/database/src/restoreDrill.ts` does the whole procedure in a scratch schema, so it is safe on any database: migrate, seed every table, create an API key, back up with `pg_dump`, drop the schema, restore with `pg_restore`, then compare a row count and an MD5 checksum of every row, per table, before and after. It fails if any table differs or if a migration is pending after the restore. CI runs it on every push.

Last local run (2026-09-18):

| Tables | Rows | Backup size | Backup | Restore | Total | Differences | Pending migrations |
|---|---|---|---|---|---|---|---|
| 31 | 99 | 102 KB | 0.7 s | 0.9 s | 2.8 s | none | none |

The fixture data is small, so these times say the procedure works, not how long a production restore takes. Time a restore of a production sized copy before relying on a recovery time.

## Not covered yet

- No schedule. Backups are run by hand. How often, and how long they are kept, belongs to the release checklist (I20).
- No point in time recovery. Anything written after the last backup is lost. Continuous archiving (WAL) needs a hosting decision.
- Redis is not backed up, by design.
