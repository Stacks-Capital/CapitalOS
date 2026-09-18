# Rollback

How to go back to the previous release when a new one misbehaves. Rollback changes code only. It cannot reverse anything already on chain, and migrations only go forward.

## Before rolling back

1. If users could lose funds, switch the affected capability off first (`pnpm ops:disable`, see [incidents](incidents.md)). That is faster than a rollback and needs no deploy.
2. Pick the target release. It must be **at or after the I17 merge (`3d2d89e`)**. Older releases do not read operator switches, so they would show every switched off capability as enabled again. The rollback drill below catches this.
3. Run the drill against the target:

   ```bash
   pnpm release:rollback-drill <target commit or tag>
   ```

   Do not roll back if it fails.

## Roll back

1. Deploy the target release's code for the API and the worker.
2. **Do not run `db:migrate` from the older release.** It refuses a database that has newer migrations (`Applied migration ... is missing`), which is correct: the older code runs on the newer schema as it is.
3. Check `pnpm ops:status mainnet`: alerts clear and the overrides are still listed.

## Roll forward

Deploy the fixed release and run its `pnpm db:migrate`. Nothing the older release did needs a migration, so it applies only what is new.

## The drill

`scripts/release/rollbackDrill.ts` migrates a scratch database with the current checkout and seeds it. It then extracts the target release with `git archive`, installs it, and checks:

| Check | Why |
|---|---|
| The older `db:migrate` leaves the database unchanged | A rollback must not rewrite migration history |
| The older API honours an operator switch set before the rollback | A rollback must not turn a switched off action back on |
| The older API reads markets, capabilities, earn options and prices | Users keep seeing data |
| The older API writes a sign in challenge | Sign in keeps working |
| The current `db:migrate` applies nothing afterwards | Rolling forward is clean |

It needs `DATABASE_URL` and `REDIS_URL`, and it drops its scratch database when it finishes.

Results on 2026-09-18, with the current checkout at `0e09f96`:

| Target | Result | Notes |
|---|---|---|
| `origin/main` (`b516166`, M4 with K15 to K18) | Passed, 8 of 8 | Same 9 migrations; older migrate found nothing to do |
| `bc4dc3a` (M3, before `0009_ops`) | Failed, 7 of 8 | Older migrate refused as expected. Older API ran fine on the newer schema, but showed a switched off capability as enabled |
