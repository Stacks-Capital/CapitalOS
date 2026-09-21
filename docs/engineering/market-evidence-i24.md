# Market, Rate, Liquidity, and Capacity Evidence Persistence (I24)

| | |
|---|---|
| Task | I24 Persist market, rate, liquidity and capacity evidence |
| Requirements | CAP-01, POS-01, WF-01, OPS-01 |
| Owner / reviewer | IBK / Kenzman |
| Depends on | I22, K24 |
| Date | 2026-09-21 |

Deliverable: Persist source-tagged protocol snapshots (`market_snapshots`, `price_snapshots`, `reconciliation_runs`), expose evidence age, block, confidence, and disagreement through REST APIs and client SDK, guarantee zero-vs-null financial semantics, contrast independent onchain reads (`hiro-read`) from provider reports, and enforce allocation guards in earn comparison.

## Architecture

### 1. Source-Tagged Evidence & Provenance
Financial projections are stored with full provenance in `market_snapshots`, `price_snapshots`, and `reconciliation_runs`:
- `source`: Distinguishes between independent onchain state machine reads (`hiro-read`) and provider-reported telemetry (e.g. `zest`, `alex`, `granite`).
- `block_height` & `block_hash`: Pins the exact onchain tip when the snapshot was observed.
- `rate_scale`: Rates are stored as exact scaled integers (`numeric(78, 0)`), preventing floating-point drift.
- `reconciliation_runs`: Periodically compares independent onchain reads against provider-reported values, flagging `match`, `mismatch`, or `unavailable`.

### 2. Evidence Age, Confidence, and Disagreement
Evidence is served via:
- `GET /v1/markets/:id/evidence`: Exposes all recent observations grouped by source, telemetry age (`evidenceAgeSeconds`), confidence level (`high`, `medium`, `low`), and reconciliation disagreement status.
- `GET /v1/earn/options`: Appends `evidence` object (`EarnOptionEvidence`) to each earn option:
  ```json
  "evidence": {
    "ageSeconds": 42,
    "blockHeight": 125000,
    "blockHash": "0xfeedface",
    "confidence": "high",
    "source": "hiro-read",
    "disagreement": null,
    "isIndependentRead": true
  }
  ```
- Confidence levels:
  - `high`: Verified against fresh independent onchain read without reconciliation mismatch.
  - `medium`: Provider report observed or warning flag present without critical mismatch.
  - `low`: Stale snapshot, reconciliation mismatch (`status = 'mismatch'`), or disagreement detected.

### 3. Allocation Invariant in Compare Engine (`compareEarn`)
Financial safety requires that stale or unverified data cannot drive allocation:
- **Exhausted Capacity**: If `capacity === "0"` or `availableLiquidity === "0"`, the market cannot accept funds; marked `rankable = false` with note `"Capacity or available liquidity is exhausted."`
- **Stale Rates**: If `stale === true` or evidence age exceeds 300 seconds (`EARN_OPTION_MAX_AGE_MS`), the option is marked `rankable = false` with note `"The last reading is stale."`
- **Low Confidence / Disagreement**: If `evidence.confidence === "low"` or `evidence.disagreement === true`, the market is disqualified from earn allocation (`rankable = false`).

### 4. Null vs. Zero Semantics
In financial ledgers, `0` represents an empty balance or exhausted capacity. Missing, unobserved, or unread values are always `null` accompanied by warnings in `warnings[]`, never numeric zero.

## API & Client Interface

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/markets/:id/evidence?network=mainnet` | Returns `MarketEvidence` with source-tagged observations, telemetry age, confidence, and reconciliation status |
| `GET` | `/v1/earn/options?network=mainnet` | Lists earn options with inline `evidence` provenance |
| SDK | `client.marketEvidence(marketId)` | Type-safe method on `CapitalClient` returning `Result<MarketEvidence>` |

## Acceptance Evidence

1. **Missing evidence is null plus warnings, never numeric zero**:
   - Verified in `apps/api/test/integration/evidence.test.ts`.
   - Unobserved markets return `rate.supplyRate = null`, `liquidity.available = null`, `liquidity.capacity = null` with explicit warnings, never `0` or `"0"`.
2. **Stale rate or capacity cannot drive earn allocation in `compareEarn`**:
   - Verified in `packages/ui/src/compare.test.ts`.
   - Stale rates, exhausted capacity (`"0"`), and low confidence / reconciliation disagreements prevent options from receiving ranks (`rank = null`).
3. **Independent onchain reads (`hiro-read`) and provider-reported observations remain distinguishable**:
   - Verified in `apps/api/test/integration/evidence.test.ts`.
   - `MarketObservation` exposes `sourceType: "independent" | "provider_reported"` and `isIndependentRead: boolean`.
   - Reconciliation discrepancies between independent onchain reads and offchain provider values are exposed and downgrade confidence to `low`.
