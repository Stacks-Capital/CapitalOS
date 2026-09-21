# Registry backfill and canonical history continuously (I23)

| | |
|---|---|
| Task | I23 Operate registry backfill and canonical history continuously |
| Requirements | CAP-01, POS-01, WF-01, OPS-01 |
| Owner / reviewer | IBK / Kenzman |
| Depends on | I22, K23 |
| Date | 2026-09-21 |

Deliverable: Operate registry backfill, schedule canonical snapshots, advance projections continuously on new blocks without manual commands, verify all signed-registry checkpoints via projection audit, and guarantee reorg-safe replay and state rebuilding.

## Architecture

### 1. Signed-Registry Checkpoints & Coverage
Every active market deployment in the signed capability registry (`deployments.ts`) has a pinned revision and capability state. The database maintains ingestion checkpoints in `ingestion_checkpoints (chain, network, height, hash, updated_at)`.
- `listAllCheckpoints(sql)` tracks all active chain checkpoints.
- `getMissingSnapshotTargets(sql, network, source)` detects any active market that lacks a canonical projection snapshot.

### 2. Continuous Block & Projection Advancement
In continuous operation (`apps/worker/src/processes/ingest.ts`), when `ingestTick` detects new canonical blocks (`blocks > 0`):
- Checkpoints advance atomically with recorded blocks and raw events.
- When `advanceProjections: true`, downstream canonical snapshots (markets, DIA oracle prices, rewards, owner positions) are automatically updated for the new block height without manual CLI commands.

### 3. Reorg Replay & State Rebuilding
When a chain reorg is detected (`hiro.blockAt(checkpoint.height).hash !== checkpoint.hash`):
1. `findCommonAncestor`: Walks backward until stored evidence and the chain agree.
2. `markReorg`: Rewinds the checkpoint to the ancestor height and marks all orphaned blocks, raw events, and activities `canonical = false`. Zero evidence is deleted.
3. `reorgReplay`: Follows the replacement fork forward, stores new canonical blocks, decodes events, and immediately re-evaluates canonical projections on the new fork.

### 4. Projection Audit
`auditProjections(sql, network)` provides structured health verification:
- Verifies checkpoint existence and freshness.
- Verifies that every active target from `listProjectionTargets` has a canonical snapshot.
- Verifies required oracle feeds (`BTC/USD`, `STX/USD`, `sBTC/USD`).
- Aggregates reconciliation run statistics (`match`, `mismatch`, `unavailable`).

## Commands

| Command | Action |
|---|---|
| `pnpm worker:audit` | Runs `auditProjections` and prints formatted JSON report; exits with code 1 if unhealthy |
| `pnpm worker:backfill` | Runs historical backfill up to target height |
| `pnpm worker:backfill -- --reproject --audit` | Runs backfill, reprojects canonical state, and runs projection audit |
| `pnpm worker:ingest` | Runs the continuous ingestion loop |

## Acceptance Evidence

1. **Projection audit passes with every checkpoint complete**:
   - Verified in `apps/worker/test/integration/i23-backfill-audit.test.ts`.
   - `auditProjections()` validates all active markets and DIA oracle price feeds, returning `isHealthy: true`.
2. **A new block advances projections without manual commands**:
   - `ingestTick({ advanceProjections: true })` advances checkpoints and triggers snapshot updates on new blocks.
3. **Reorg replay removes orphaned evidence and rebuilds affected state**:
   - Tested against multi-block reorgs: orphaned evidence is preserved with `canonical = false`, replacement fork is ingested, and fresh projections are built for the new tip.
