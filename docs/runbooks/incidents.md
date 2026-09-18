# Incident runbook

What to do when something goes wrong. Each entry lists how the problem shows up, what to do first, how to confirm it is fixed, and when to escalate. The alerts and switches come from [operations](../engineering/operations.md). The expected system behaviour comes from the [failure injection drill](../discovery/failure-injection-drill.md), which proves these failures are handled safely in code.

## First five minutes

1. Look at the state:

   ```bash
   pnpm ops:status mainnet
   ```

   It prints ingestion health, quote failures per market in the last 15 minutes, stuck workflows, open alerts and operator overrides.
2. If users could lose funds or sign something wrong, switch the capability off first and investigate after:

   ```bash
   pnpm ops:disable mainnet <market> <action> "<reason shown to users>"
   ```

   It takes effect on the next request, with no deploy. Quotes, plans and new workflows are refused with `CAPABILITY_DISABLED`; the worker keeps monitoring the market.
3. Write down the time, the alert, the request ids or workflow ids, and every command run. That record is the incident log.

Markets: `sbtc.deposit`, `sbtc.withdraw`, `zest.sbtc.vault`, `granite.sbtc.isolated`, `bitflow.sbtc-usdcx`. Actions: `deposit_sbtc`, `withdraw_sbtc`, `supply`, `withdraw_supply`, `borrow`, `repay`, `swap`.

## Severity

The scale from page 03 of the spec.

| Level | Means | Examples | First move |
|---|---|---|---|
| SEV-0 | Suspected active loss of funds, or a compromised registry | Protocol exploit, a plan that moves the wrong asset | Disable the affected writes at once |
| SEV-1 | Wrong transaction plan or risk number, or one tenant seeing another's data | Leaked API key, reconciliation mismatch, reorg after completion | Disable the affected action, revoke keys |
| SEV-2 | Stuck workflows, large data mismatch, major provider outage | Ingestion failing, oracle stale, quote failure spike, API or database down | Follow the entry below |
| SEV-3 | Degraded read or UI | Ingestion lag warning, one workflow awaiting a signature | Watch, fix in working hours |

## Ingestion lag or failing

**Shows as:** `ingestion_lag` (30 blocks warning, 120 critical) or `ingestion_failing` (checkpoint unmoved for 10 minutes, or 3 failed ticks). Positions, rates and activity stop updating. They are not marked stale on their own: `stale` is set when a projection is written, so check `observedAt` to see how old the data is.

**Do:**
1. Check the worker is running and read its last log lines.
2. Check the provider: `curl -s https://api.hiro.so/extended/v2/blocks?limit=1`. A 429 means rate limited: set `HIRO_API_KEY` in `.env.local` if it is missing.
3. Run one tick by hand and read the error: `pnpm worker:tick`.

**Fixed when:** the alert resolves (a resolve line is printed) and `blocksBehind` in `ops:status` is under 30.

**Escalate:** if the provider is down for more than 30 minutes, consider pausing actions that depend on fresh positions (`borrow`, `withdraw_supply`), since risk numbers are stale.

## Quote failure spike

**Shows as:** `quote_failures` for a market, with the codes that failed.

**Do:** read the codes in the alert.

| Code | Likely cause | Action |
|---|---|---|
| `ORACLE_STALE` | The price feed stopped updating | See stale oracle below |
| `CAP_REACHED` | The market is full | Nothing to fix. Users are told to lower the amount |
| `PROVIDER_TIMEOUT` | Hiro is slow or down | See provider outage below |
| `CAPABILITY_DISABLED` | An override or the registry disabled it | Expected while switched off |
| `INTERNAL` | A bug | Collect request ids, pause the action if it keeps failing |

**Fixed when:** the alert resolves after the 15 minute window has good quotes again.

## Stale oracle

**Shows as:** `ORACLE_STALE` on borrow or swap quotes; the drill proves no executable plan is produced.

**Do:** users are already protected. Check the DIA feed age on the risk panel (`GET /v1/markets/granite.sbtc.isolated/risk`). If it stays stale for more than 30 minutes, pause borrow so users see a reason instead of repeated failures:

```bash
pnpm ops:pause mainnet granite.sbtc.isolated borrow "price feed is delayed"
```

**Fixed when:** the price is fresh again. Remove the pause with `pnpm ops:enable mainnet granite.sbtc.isolated borrow`.

## Stuck workflows

**Shows as:** `workflow_stuck`, one alert per workflow. `ops:status` lists them under `metrics.stuck` with their age.

| State | Next action for the user | What it means | Do |
|---|---|---|---|
| `AWAITING_SIGNATURE` (30 min) | `SIGN` | The user left, or the wallet hung | Nothing unless the user asks. It is not broadcast, so no funds moved |
| `SUBMITTED`, `CONFIRMING`, `RECONCILING` (60 min) | `WAIT` | Slow chain, or ingestion is behind | Check ingestion first. Then look up the txid in `transaction_attempts` on the explorer |
| `BROADCAST_UNKNOWN` | `RETRY_READ` | The wallet answered without a txid | Never ask the user to sign again. Find the transaction by the user's address and nonce on the explorer. If found, record it; if the nonce was never used, nothing was sent |
| `REORGED` | `CONTACT_SUPPORT` | A block the workflow relied on was replaced | Check whether the transaction is in the new canonical chain. Events are kept, not deleted |
| `MANUAL_REVIEW` | `CONTACT_SUPPORT` | The system cannot decide | Compare the chain with the workflow's steps and contact the user |
| `ACTION_REQUIRED` | `FOLLOW_UP` | Part of a multi step action succeeded, for example collateral in and borrow refused | Contact the user: their collateral is supplied and they choose to borrow again or withdraw. It is not a failure |

**Fixed when:** the workflow moves on and its alert resolves.

**Gap:** there is no command to move a workflow to another state. Resolving one today means a reviewed SQL change by an engineer. `ACTION_REQUIRED` has no stuck limit, so it does not alert; check `GET /v1/workflows` or the database for it.

## Provider outage (Hiro)

**Shows as:** `PROVIDER_TIMEOUT` errors, ingestion failing, stale data everywhere.

**Do:** reads are retried by the client, then the API keeps serving the last projection with its `observedAt` time. It is not marked stale by age, so users may see old numbers without a warning. Pause actions that need fresh state (`borrow`, `swap`) if the outage lasts over 30 minutes. Remove the pauses once ingestion catches up.

## Redis down

**Shows as:** every request returns 503 `TEMPORARY_UNAVAILABLE` with "Rate limiting is unavailable". This is fail closed on purpose: without Redis the API cannot enforce limits, so it refuses rather than serve without them.

**Do:** `pnpm services:up`, or restart the managed Redis. Nothing to restore: it only holds counters.

**Fixed when:** requests succeed again. No restart of the API is needed.

## Postgres down

**Shows as:** the API returns `INTERNAL` and the worker fails every tick (`ingestion_failing` cannot be recorded either, so watch the worker logs).

**Do:** restart Postgres. If data is lost or corrupt, follow [backup and restore](backup-restore.md), including its checks on operator overrides and revoked keys.

## API key leak

**Shows as:** a key found in a repository, a log, a browser bundle or a message.

**Do:**
1. Revoke it at once. The key id is the part of the token before the dot:

   ```bash
   pnpm keys:revoke key_...
   ```

2. Create a replacement and give it to the owner through a secret store, not chat:

   ```bash
   pnpm keys:create <app id> <scope...>
   ```

3. If it was committed, removing it from history does not undo the leak. The revoke is what matters.

**Fixed when:** a request with the old key returns `UNAUTHORIZED`.

A leaked session token (`ses_...`) expires on its own; a leaked client id (`pk_...`) is public by design and only works from its allowed origins.

## Protocol exploit or pause

**Shows as:** news from the protocol, a contract paused onchain, or a `RECONCILIATION_MISMATCH`.

**Do:**
1. Disable every action on the affected markets, supply side first:

   ```bash
   pnpm ops:disable mainnet zest.sbtc.vault supply "Zest has paused deposits, investigating"
   pnpm ops:disable mainnet zest.sbtc.vault withdraw_supply "Zest has paused withdrawals, investigating"
   ```

2. Keep the worker running so positions and events keep being recorded.
3. Do not tell users their funds are safe or lost until the protocol confirms. Show what the chain shows.

**Fixed when:** the protocol confirms it is safe, the contract revision is checked against `CONTRACTS` in config, and the overrides are removed with `ops:enable`.

## Closing an incident

1. Every alert resolved, every override either removed or kept on purpose with its reason.
2. The incident log saved with a short summary: what happened, impact, what was done, what to change.
3. A test or drill added if the failure was not already covered.

## Reproduction record

Another engineer follows the [quickstart](../guides/quickstart.md) on a clean machine and fills this in. Anything unclear goes into the docs in the same pull request.

| Step | Result | Notes |
|---|---|---|
| Prerequisites and `pnpm install` | | |
| `services:up`, `db:migrate`, `fixtures:seed` | | |
| API, worker tick, web app, partner example running | | |
| `pnpm run ci` | | |
| `pnpm test:integration` | | |
| `pnpm test:browser` | | |
| `pnpm db:restore-drill` | | |
| One incident step tried (`ops:disable`, then `ops:enable`) | | |
| Reproduced by, date, commit | | |
