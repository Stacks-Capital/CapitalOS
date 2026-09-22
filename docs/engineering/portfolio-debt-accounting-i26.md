# Canonical Portfolio and Debt Accounting (I26)

| | |
|---|---|
| Task | I26 Complete canonical portfolio and debt accounting |
| Track | Portfolio & Risk |
| Owner / reviewer | IBK / Kenzman |
| Depends on | I25 |
| Date | 2026-09-22 |

Deliverables: Normalize capital across `wallet`, `supplied`, `lp`, `collateral`, `debt`, and `locked` categories; prevent receipt-token and underlying-claim double counting; link borrowed tokens directly to backing collateral; and enforce exact net subtotal arithmetic ($$\text{grossAssets} - \text{grossDebt} \equiv \text{netWorth}$$).

## Architecture

### 1. Six Canonical Capital Categories
Capital is partitioned across six mutually exclusive categories in `packages/core/src/accounting.ts`:
- **`wallet`**: Native and SIP-010 assets held directly in user wallets.
- **`supplied`**: Assets deposited into lending/yield vaults (e.g. Zest sBTC vault) earning passive return.
- **`lp`**: Liquidity pool tokens and pairs deployed to automated market makers (e.g. Bitflow).
- **`collateral`**: Assets committed to secure credit lines or isolated lending markets (e.g. Granite sBTC collateral).
- **`debt`**: Active borrow obligations and accrued liabilities (e.g. Granite USDC debt).
- **`locked`**: Staked STX (PoX) or protocol-timelocked positions.

Normalizer function `normalizeCapitalCategory(kind)` maps protocol-specific snapshot kinds and UI position kinds to one of these six canonical categories.

### 2. Receipt Token Deduplication
Receipt tokens (such as Zest `zft` / `zsBTC`) represent claims on underlying protocol pools. Counting both the wallet balance of a receipt token and the protocol position's supplied balance would result in double-counting:
- When a wallet balance corresponds to a known receipt token (`m.receiptAssetId`), `isReceipt: true` is assigned and `countsTowardTotal: false` is enforced.
- The receipt token is retained in the ledger for full evidentiary auditability and provenance, but omitted from aggregate asset subtotals.
- A descriptive warning is attached: `"Receipt for <marketId>. Represented by protocol position; not double-counted"`.

### 3. Structural Debt-to-Collateral Linking
Debt positions in isolated and cross-margin markets must visibly link to their backing collateral:
- Each debt entry carries a `linkedCollateral` reference (`LinkedCollateralRef`):
  ```typescript
  export type LinkedCollateralRef = {
    marketId: string;
    assetId: string;
    protocolKey?: string;
    quantity?: string | null;
  };
  ```
- Linking matches debt positions to collateral positions within the same isolated market deployment (e.g. `granite.sbtc.isolated`).
- In the UI and API endpoints (`/v1/positions` and `/v1/portfolio`), users and client applications can inspect the collateral directly supporting each liability.
- If a debt position has no visible backing collateral in the ledger, a prominent warning is flagged: `"Debt in <marketId> has no visible collateral position"`.

### 4. Exact Net Subtotal Arithmetic
To eliminate floating-point discrepancy and rounding leakage across multi-asset portfolios:
- All valuations are computed in integer units of $$10^{-8}$$ USD.
- Gross assets are aggregated across all verified asset categories (`wallet + supplied + lp + collateral + locked`).
- Gross debt is aggregated across all verified `debt` entries.
- Net worth is calculated by exact BigInt subtraction:
  $$\text{netWorthUsd} = \text{grossAssetsUsd} - \text{grossDebtUsd}$$
- Invariant guarantee: `BigInt(grossAssetsUsd) - BigInt(grossDebtUsd) === BigInt(netWorthUsd)`.
- If any required asset or debt entry cannot be valued (due to missing quantity, oracle disagreement, or unsupported feed), the subtotal is marked `incomplete: true`, and partial coverage metrics disclose the valued vs unvalued ratio.

## API & Client Interface

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/portfolio?network=mainnet&owner=:address` | Returns canonical portfolio ledger, gross assets, gross debt, net worth, category breakdowns, and coverage |
| `GET` | `/v1/positions?network=mainnet&owner=:address` | Returns protocol positions enriched with `linkedCollateral` on debt rows |
| SDK | `client.portfolio({ owner })` | Client SDK method returning `Result<PortfolioAccountingView>` |

## Acceptance Verification

1. **Acceptance Evidence 1: Golden addresses reconcile against explorer and protocol reads**:
   - Evaluated via `reconcileGoldenPortfolioAccounting()` in `packages/fixtures/src/goldenAddresses.ts`.
   - Reconciles golden addresses against explorer wallet balances, Zest protocol positions, and Granite isolated credit positions.
2. **Acceptance Evidence 2: Assets minus debt equals displayed net subtotal exactly**:
   - Verified via integration tests in `apps/api/test/integration/portfolio-accounting.test.ts` and unit tests in `packages/core/src/accounting.test.ts` and `packages/ui/src/holdingsAccounting.test.ts`.
   - Exact integer invariant `BigInt(grossAssetsUsd) - BigInt(grossDebtUsd) === BigInt(netWorthUsd)`.
3. **Acceptance Evidence 3: Borrowed token is visibly linked to its collateral position**:
   - Verified in `/v1/positions` and `/v1/portfolio` where debt positions carry non-null `linkedCollateral` referencing backing collateral market, asset ID, and quantity.
4. **Prevents receipt-token double counting**:
   - Verified that receipt tokens (`zft`) in wallet balances carry `countsTowardTotal: false` and do not inflate gross assets.
