# Price and Oracle Quorum Valuation (I25)

| | |
|---|---|
| Task | I25 Harden price and oracle quorum valuation |
| Track | Portfolio & Risk |
| Owner / reviewer | IBK / Kenzman |
| Depends on | I24 |
| Date | 2026-09-22 |

Deliverables: Reconcile supported assets across independent price sources, enforce fail-closed guards on quorum disagreements, label unsupported assets without withholding unrelated verified values, and disclose valued and unvalued coverage in partial portfolio totals.

## Architecture

### 1. Quorum Reconciliation Model
Prices and oracle valuations are reconciled across independent sources (`dia-oracle`, `pyth-oracle`, secondary sources) in `packages/core/src/valuation.ts`:
- **Asset Identification**: Every valuation carries canonical asset ID (`assetId`), price (`price`), source set (`sourceSet`), and observation timestamp (`timestamp`).
- **Quorum Spread Calculation**:
  $$\text{spreadBps} = \frac{\text{maxPrice} - \text{minPrice}}{\text{minPrice}} \times 10{,}000$$
- **Quorum Tolerance**: Defaulted to `DEFAULT_MAX_QUORUM_SPREAD_BPS = 300n` (3.0%).
- **Quorum Resolution**:
  - `status = "verified"`: Sources agree within tolerance; canonical price is the median.
  - `status = "disputed"`: Multiple independent sources disagree by more than tolerance; `disagreement = true`, `price = null` (withheld).
  - `status = "stale"`: Observations exceed maximum age or are flagged stale.
  - `status = "unsupported"`: Asset has no registered or observed oracle feed.

### 2. Fail-Closed Action Semantics
Financial safety dictates that disputed or unverified prices cannot authorize financial actions:
- **Quotes**: `createQuote` and `quoteUnchecked` check oracle quorum for action feeds (collateral and debt). If any feed has `disagreement = true` or `status = "disputed"`, quoting fails closed with HTTP 409 and error code `QUORUM_DISAGREEMENT`.
- **Borrow Projections**: `projectBorrow` in `packages/ui/src/borrow.ts` adds a blocker when an oracle feed has quorum disagreement: `"The <feedKey> price sources disagree (quorum disagreement). Financial actions fail closed."`
- **Granite Protective Actions**: `interpretGraniteHealth` and `graniteProtectiveActions` refuse write actions when an oracle feed has quorum disagreement, documenting `"Oracle has quorum disagreement; action fails closed until price sources agree."`

### 3. Partial Portfolio Valuation & Coverage Disclosure
When valuing a portfolio holding:
- **Non-Withholding of Verified Values**: If asset A is unsupported or disputed, its value is withheld, but unrelated verified assets (e.g. BTC, sBTC, STX) are NOT withheld and continue to produce accurate USD totals.
- **Labeling Unsupported Assets**: Assets without oracle feeds are tagged with `status: "unsupported"` and explicit reasons (`"Asset <id> has no supported price oracle feed"`).
- **Explicit Coverage Reporting**: Every portfolio valuation discloses:
  ```json
  "coverage": {
    "isComplete": false,
    "valuedCount": 2,
    "unvaluedCount": 1,
    "totalCount": 3,
    "coverageBps": 6667,
    "valuedAssets": ["stacks:mainnet:native:btc", "stacks:mainnet:native:stx"],
    "unvaluedAssets": [
      { "assetId": "stacks:mainnet:sip10:unsupported-token", "reason": "Asset has no supported price oracle feed" }
    ]
  }
  ```

## API & Client Interface

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/prices?network=mainnet` | Returns latest prices with inline `assetId`, `sourceSet`, `disagreement`, and `status` |
| `GET` | `/v1/prices/valuations?network=mainnet` | Returns reconciled multi-source quorum valuations for all supported feeds |
| `GET` | `/v1/markets/:id/risk?network=mainnet` | Returns market risk including `collateralOracle` and `debtOracle` with quorum flags |
| `POST` | `/v1/quotes` | Mint quote and plan; fails closed with 409 `QUORUM_DISAGREEMENT` on oracle disputes |
| SDK | `client.priceValuations()` | Returns `Result<{ items: AssetValuation[] }>` |

## Acceptance Verification
1. **Every valuation carries asset ID, price, source set and timestamp**: Verified in `packages/core/src/valuation.test.ts` and `apps/api/test/integration/quorum-valuation.test.ts`.
2. **Quorum disagreement fails closed for actions**: Verified against diverging multi-source feeds rejecting quotes with HTTP 409 `QUORUM_DISAGREEMENT`.
3. **Partial portfolio totals disclose valued and unvalued coverage**: Verified in core evaluation tests and integration suite.
