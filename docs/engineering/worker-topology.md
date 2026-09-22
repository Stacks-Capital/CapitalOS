# Worker topology and production packaging

| | |
|---|---|
| Task | I22 Ship production database migrations and worker topology |
| Requirements | CAP-01, POS-01, WF-01, OPS-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I04 database, I06 market ingestion, I21 operations |
| Date | 2026-09-21 |

Deliverable: Package database migrations, advisory locks, queues, and worker entrypoints into four distinct runnable worker processes plus a target-agnostic container and health probe server.

---

## 1. Process Decomposition

Previously, `apps/worker` ran a single monolithic tick loop (`tick.ts`) executing ingestion, market projections, rewards, owner positions, reconciliation, and alert evaluation in a single sequential sweep.

In production, heavy ingestion runs or network-level block reorgs should not stall oracle price observation or alert evaluation. Under I22, the worker topology is decomposed into four discrete, independently runnable processes:

```
                            +--------------------------+
                            |     PostgreSQL DB        |
                            | (Session Advisory Locks) |
                            +------------+-------------+
                                         |
          +-------------------+----------+----------+-------------------+
          |                   |                     |                   |
          v                   v                     v                   v
+-------------------+ +---------------+     +---------------+   +---------------+
|     backfill      | |    ingest     |     |   observer    |   |   reconcile   |
| (One-shot range)  | |  (Continuous) |     |  (Continuous) |   |  (Continuous) |
| • Historical sync | | • Blocks      |     | • DIA prices  |   | • Projected   |
| • Checkpoint walk | | • Raw events  |     | • Snapshots   |   |   vs observed |
| • Exits on finish | | • Activities  |     | • Rewards     |   | • Transactions|
|                   | | • Reorgs      |     | • Positions   |   | • Reconcile   |
|                   | |               |     | • Alerts      |   |   runs log    |
+-------------------+ +---------------+     +---------------+   +---------------+
```

### 1.1 `backfill` (One-shot bounded range)
- **Role**: Backfills historical blocks and raw contract logs across a defined height range without running in an infinite loop.
- **Execution**: Finite. Exits with status code 0 upon reaching `--to-height` or chain tip.
- **CLI / NPM**: `pnpm worker:backfill --from-height=5000000 --to-height=5000100 --batch-size=50`
- **Concurrency**: Guarded by advisory lock `capitalos:worker:backfill:<network>`.

### 1.2 `ingest` (Continuous ingestion)
- **Role**: Tracks the chain tip, ingests canonical blocks, captures raw contract logs as immutable `raw_events`, normalizes them into `canonical_activities`, advances checkpoints, and handles block reorg rewinds without deleting evidence.
- **Execution**: Continuous tick loop (`intervalMs` cadence, default 60s).
- **CLI / NPM**: `pnpm worker:ingest`
- **Concurrency**: Guarded by advisory lock `capitalos:worker:ingest:<network>`.

### 1.3 `observer` (Continuous market & alert observer)
- **Role**: Pulls DIA oracle prices, reads onchain state for watched markets, computes reward rates, updates position snapshots for known owners, and evaluates operational metrics and alert transitions.
- **Execution**: Continuous tick loop (`intervalMs` cadence).
- **CLI / NPM**: `pnpm worker:observe`
- **Concurrency**: Guarded by advisory lock `capitalos:worker:observer:<network>`.

### 1.4 `reconcile` (Continuous state reconciliation)
- **Role**: Reconciles projected market state against fresh chain reads (`reconciliation_runs`), categorizing results into `match`, `mismatch`, or `unavailable`. Compares workflow steps and transaction attempts against confirmed chain state.
- **Execution**: Continuous tick loop (`intervalMs` cadence).
- **CLI / NPM**: `pnpm worker:reconcile`
- **Concurrency**: Guarded by advisory lock `capitalos:worker:reconcile:<network>`.

### 1.5 `all` (Unified development mode)
- **Role**: Preserves 100% backward compatibility for local development (`pnpm worker:run`, `pnpm worker:tick`), running the combined pipeline in a single process.

---

## 2. Advisory Locking Architecture

To prevent split-brain execution across auto-scaling containers or duplicate cron jobs, all worker processes coordinate using PostgreSQL session-level advisory locks:

```sql
-- Acquire lock (non-blocking)
SELECT pg_try_advisory_lock(hashtext('capitalos:worker:' || :process || ':' || :network)) AS acquired;

-- Release lock
SELECT pg_advisory_unlock(hashtext('capitalos:worker:' || :process || ':' || :network)) AS released;
```

- **Session-bound**: If a worker process crashes, terminates abruptly, or loses connection, PostgreSQL automatically releases session advisory locks immediately.
- **Non-blocking**: If another instance already holds the lock, subsequent workers log a warning and back off rather than deadlocking or duplicating mutations.

---

## 3. Health Server and Probes

`apps/worker/src/health.ts` provides observability and health reporting across container orchestrators:

### 3.1 HTTP Endpoints
When `WORKER_HEALTH_PORT` is configured (or `--health-port=<port>`):
- **`GET /health` / `GET /livez`**: Returns HTTP 200 `{"status":"ok"}` indicating process liveness.
- **`GET /readyz`**: Verifies database connectivity and readiness. Returns 200 when ready, 503 if the database is unreachable.
- **`GET /status`**: Returns detailed metrics snapshot:
  ```json
  {
    "status": "ok",
    "network": "mainnet",
    "timestamp": "2026-09-21T19:49:34.123Z",
    "ingestion": {
      "checkpointHeight": 5000005,
      "checkpointHash": "0xb5000005",
      "checkpointAt": "2026-09-21T19:49:30.000Z",
      "blocksBehind": 0,
      "lastTickAt": "2026-09-21T19:49:30.000Z",
      "failuresInWindow": 0
    },
    "alerts": []
  }
  ```

### 3.2 CLI Probe for Container HEALTHCHECK
In container environments where opening an HTTP port is not desired or for direct shell probes:
```bash
node --experimental-strip-types apps/worker/src/health.ts --cli
# Exit code 0: Healthy
# Exit code 1: Unhealthy (errors logged to stderr)
```

---

## 4. Environment Contract

The worker container and CLI entrypoints adhere to the following configuration contract:

| Variable | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | String | *Required* | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`) |
| `WORKER_PROCESS` | String | `all` | Process to run: `all`, `ingest`, `observer`, `reconcile`, `backfill` |
| `WORKER_NETWORK` | String | `mainnet` | Target network (`mainnet`, `testnet`, `devnet`) |
| `WORKER_INTERVAL_MS`| Integer| `60000` | Loop interval in milliseconds (minimum `1000`) |
| `WORKER_HEALTH_PORT`| Integer| `undefined` | Port for HTTP health server (e.g. `3001`). Omit to disable HTTP server |
| `HIRO_API_KEY` | String | `undefined` | Optional Hiro API key for higher rate limits |
| `BACKFILL_FROM_HEIGHT`| Integer | Current checkpoint | Starting block height for `backfill` process |
| `BACKFILL_TO_HEIGHT` | Integer | Chain tip | Ending block height for `backfill` process |
| `BACKFILL_BATCH_SIZE` | Integer | `50` | Maximum blocks per backfill batch |

---

## 5. Target-Agnostic Container (`Dockerfile.worker`)

The worker container is packaged with a target-agnostic multi-stage build running on Node 24 (`node:24-alpine`):
- **Base**: Minimal Alpine Linux with Node 24 and Corepack (pnpm).
- **Dependencies**: Workspace dependency installation using frozen lockfile and pnpm cache mount.
- **Runner**: Non-root `node` user, exposing port 3001, with native `HEALTHCHECK` using `health.ts --cli`.
- **Hosting-Agnostic**: Compatible with Kubernetes Pods/Deployments, AWS ECS / Fargate, Fly.io, Railway, GCP Cloud Run (worker mode), or Nomad.

---

## 6. Restart Idempotency Guarantees

Restart idempotency was verified via `apps/worker/test/integration/idempotency.test.ts`:
1. **Raw Events**: Unique constraint on raw event IDs ensures repeated ingestion produces 0 duplicate records.
2. **Canonical Activities**: Deduplication key on `(raw_event_id, kind)` guarantees identical activity count after restart.
3. **Chain Blocks**: Stored canonical blocks and checkpoints prevent re-inserting already-processed block heights.
4. **Financial Snapshots**: Market snapshots, price snapshots, and reward snapshots use unique constraint keys on entity and observation time, discarding duplicate readings safely.
