# Earned Yield Attribution, Rewards and Historical Performance (I27)

| | |
|---|---|
| Task | I27 Attribute earned yield, rewards and historical performance |
| Track | Earn |
| Owner / reviewer | IBK / Kenzman |
| Depends on | I23, I24, I26 |
| Date | 2026-09-22 |

Deliverables: Reconcile deposits, withdrawals, fees, rewards, and share-rate changes; separate realized earnings, accrued estimate, and forward projection; enforce that no balance increase is called yield without cash-flow attribution; gate thirty-day projections behind verified rates; and construct history charts strictly from two or more canonical observations without synthetic points.

## Architecture

### 1. Cash-Flow Attribution Engine
Stacks Capital strictly avoids mistaking arbitrary balance increases for earned yield:
- An external deposit, token transfer, or unmodeled balance increase is **never** labeled as yield.
- Every position change is audited against canonical cash flows:
  - **`deposit`**: Inflows of capital that establish or increase cost basis.
  - **`withdrawal`**: Outflows of capital that reduce basis and lock in realized returns.
  - **`fee`**: Costs deducted from gross returns.
  - **`reward_claim`**: Token rewards claimed onchain.
- Legitimate earned yield is computed strictly from share-rate appreciation and verified cash-flow events:
  $$\text{Expected Underlying} = V_{\text{start}} + \sum \text{Deposits} - \sum \text{Withdrawals} + \text{ShareAppreciation}$$
- When actual balance exceeds the legitimate expected value, the difference is partitioned into:
  - `unattributedInflow`: Captured with full disclosure, flagged with `hasUnattributedInflow: true`, and strictly excluded from `earnedYield`.
  - A prominent warning is generated: `"Balance increase of <amount> <asset> has no cash-flow or share-rate attribution; classified as unattributed inflow and excluded from earned yield."`

### 2. Three-Tier Earnings Separation
Earnings are structured into three distinct, unambiguous tiers in `packages/core/src/performance.ts`:
1. **`realizedEarnings`**:
   - Gains locked in through completed redemptions/withdrawals exceeding cost basis.
   - Net claimed rewards ($$\text{Claimed Rewards} - \text{Fees}$$).
2. **`accruedEstimate`**:
   - Unrealized gains on currently held shares:
     $$\text{Share Appreciation} = \text{underlyingFromShares}(\text{shares}, \text{currentRate}) - \text{costBasis}$$
   - Unclaimed reward accruals from `reward_snapshots` where `kind = 'accrual'`.
3. **`forward30dProjection`**:
   - Forward-looking 30-day projection computed strictly with verified annualized rates:
     $$\text{projected30dAmount} = \text{principal} \times \frac{\text{annualRateBps}}{10{,}000} \times \frac{30}{365}$$
   - And converted to USD via price quorum valuations.

### 3. Strict Rate Verification Gate for Projections
Forward projections refuse to mislead users when protocol or oracle rates are untrusted:
- **`verified`**: The rate is fresh (`stale = false`), uncontradicted (`reconciliationStatus = 'match'`), and actively observed. The 30-day projection is calculated and returned.
- **`stale`**: Rate is stale (`stale = true`). Projection is strictly `null` with `unavailableReason: "Thirty-day projections require current verified rates; current rate is stale"`.
- **`disputed`**: Rate is contradicted by an independent Hiro node read (`reconciliationStatus = 'mismatch'`). Projection is strictly `null` with `unavailableReason: "Thirty-day projections require current verified rates; rate is disputed by independent node read"`.
- **`missing`**: Rate is not reported. Projection is strictly `null` with `unavailableReason: "Thirty-day projections require current verified rates; market has no reported rate"`.
- **`unverified`**: Independent verification is unavailable. Projection is strictly `null` with `unavailableReason: "Thirty-day projections require current verified rates; rate is unverified"`.
- **Invariant**: A forward projection is **never** `0` or guessed when a rate is unverified.

### 4. Canonical History Charts Without Synthetic Points
Historical performance charts are strictly grounded in canonical observations:
- Series points are constructed only from canonical observations (`position_snapshots`, `market_snapshots`, `reward_snapshots`) with verified block provenance (`source`, `blockHeight`, `blockHash`, `observedAt`).
- **Two-Point Threshold**: A chart series requires $\ge 2$ canonical observation points.
- If total canonical observations $< 2$:
  - `hasChart: false`
  - `points: []` (empty array)
  - `reason: "Insufficient canonical observations: history charts require two or more canonical observations and never synthetic points"`
- Under no circumstances does Stacks Capital inject synthetic zero points (e.g. `(0, 0)`), fabricated genesis points, or flatline placeholders.

## API & Client Interface

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/earn/performance` | Returns cash-flow attribution, 3-tier earnings, 30-day projection, and canonical chart series for an owner and market. |

Client SDK method:
```typescript
const result = await client.earnPerformance({
  owner: "SP1P72Z3704VMT3DMHPP2CB8TGQWGDBHD3RPR9GZS",
  marketId: "zest.sbtc.vault",
});
```

## Verification & Acceptance Evidence
- **Acceptance Evidence 1**: Verified in `packages/core/src/performance.test.ts` and `apps/api/test/integration/performance-attribution.test.ts`. An unexplained 50,000,000 sBTC-token balance increase is attributed to `unattributedInflow` and completely excluded from `earnedYield`.
- **Acceptance Evidence 2**: Verified in unit and integration tests. Verified rates compute accurate 30-day projections; stale, disputed, and missing rates return `null` with explicit reasons and never 0.
- **Acceptance Evidence 3**: Verified in unit and integration tests. Single-observation and zero-observation queries return `hasChart: false` with an empty array; two or more observations produce chronologically sorted canonical points with full block hash and height provenance.
