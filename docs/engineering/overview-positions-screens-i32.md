# Engineering Design & Verification: Overview and Positions Screens (I32)

## 1. Overview & Objectives

- **Task**: I32: Build Overview and Positions production screens
- **Track**: Product
- **Priority**: P0
- **Dependencies**: I26, I27, I31
- **Deliverables**:
  1. Render assets, debt, net value, deployment and yield with coverage.
  2. Expose position details and only supported position actions.
- **Acceptance Evidence**:
  1. *Partial data is explicit and internally consistent*.
  2. *Receipt tokens are not double-counted*.
  3. *Address state persists across routes and reloads*.

---

## 2. Architecture & Design

```
+-----------------------------------------------------------------------------+
|                           Stacks Capital Web Application                         |
+-----------------------------------------------------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
                   v                                       v
      +-------------------------+             +-------------------------+
      |     Overview Screen     |             |    Positions Screen     |
      |       (Portfolio)       |             |   (PositionsScreen)     |
      +------------+------------+             +------------+------------+
                   |                                       |
      +------------+------------+             +------------+------------+
      | - Gross Assets / Debt   |             | - Active Liabilities    |
      | - Net Worth Subtotal    |             | - Collateral Backing    |
      | - Valuation Coverage    |             | - Credit Health Buffers |
      | - Deployment Categories |             | - Supplied Vault Claims |
      | - 3-Tier Yield Breakdown|             | - Action Gating (Caps)  |
      | - Non-Double-Count Badg.|             | - Receipt Disclosures   |
      +-------------------------+             +-------------------------+
                   |                                       |
                   +-------------------+-------------------+
                                       |
                                       v
         +-----------------------------------------------------------+
         |                      Route & Session                      |
         |  - URL Search Sync: ?tab=Positions / ?tab=Overview        |
         |  - LocalStorage Tab Fallback: stacks-capital:active_tab        |
         |  - Network-Scoped Session: stacks-capital:session:${network}   |
         |  - Automatic Session Rehydration on Reload               |
         +-----------------------------------------------------------+
```

### 2.1 Accounting Consistency & Non-Double-Counting

1. **Explicit Identity Invariant**:
   $$\text{Gross Assets USD} - \text{Debt Liabilities USD} = \text{Net Subtotal USD}$$
   The Overview and Positions screens surface the certified calculation performed by the I26 accounting engine. Values are formatted with deterministic thousand-separators and preserved without client-side floating point rounding distortions.

2. **Receipt Token Claim Disclosures**:
   Cryptographic vault claim tokens (such as `zsBTC` or `zft` minted upon depositing into Zest pools) are tracked for asset completeness but flagged with:
   - `isReceipt: true`
   - `countsTowardTotal: false`
   In both `Portfolio` and `PositionsScreen`, receipt claims are isolated into dedicated disclosures and labeled as "Receipt Claim: Excluded to prevent double-counting" so underlying supplied collateral/assets are never counted twice.

3. **Partial State Representation**:
   When certain wallet or protocol assets lack verified oracle pricing (e.g. unlisted meme coins or newly minted pool shares), `coverage.isComplete` is `false` and `coverageBps < 10000`. The screen mounts `PartialStateView` displaying:
   - The verified USD net subtotal of all priced assets.
   - Explicit naming and reason strings for every excluded position (e.g. `"Oracle price feed unverified or missing"`).
   - Clear disclosure that unvalued assets are not included in the dollar subtotal.

---

## 3. Implementation Summary

### 3.1 Components & Modules

1. **`apps/web/src/positionsScreen.tsx`**:
   - `PositionsScreen`: Primary screen rendering verified positions partitioned into:
     - **KPI Header**: Gross Assets, Debt Liabilities, Net Subtotal, and Valuation Coverage.
     - **Credit Health & Safety Buffers**: Summarizes collateral backing, outstanding liabilities, and health status with stale oracle alerts.
     - **Supplied Positions Table**: Protocol vault supplies with capability-gated "Deposit More" and "Withdraw" actions.
     - **Collateral Positions Table**: Active collateral with "Add" and "Remove" actions.
     - **Debt Liabilities Table**: Borrowed balances with "Repay" action button.
     - **Receipt Token Disclosures**: Explicit table and notice detailing non-double-counted receipt claims.

2. **`apps/web/src/screens.tsx`**:
   - `Portfolio`: Upgraded overview component integrating `usePortfolio` and `useEarnPerformance`:
     - 4 KPI summary cards (Gross Assets, Debt Liabilities, Net Subtotal, Valuation Coverage).
     - `PartialStateView` warning notice when `!coverage.isComplete`.
     - Capital Deployment by Category grid (wallet, supplied, collateral, debt).
     - 3-Tier Yield Performance attribution (realized earnings, accrued estimate, and 30-day forward projection) with unattributed inflow warnings.
     - Holdings table with "Counted" vs "Receipt claim" net worth accounting badges.

3. **`apps/web/src/navigation.ts` & `apps/web/src/app.tsx`**:
   - Extracted navigation and session persistence into `navigation.ts`:
     - `getInitialTab(urlSearch?, storage?)`: Prioritizes URL `?tab=...`, falls back to `localStorage[stacks-capital:active_tab]`, defaults to `"Overview"`.
     - `getInitialSession(network, storage?)`: Rehydrates session per active network (`stacks-capital:session:${network}`).
   - Wired `PositionsScreen` into the shell navigation bar and connected `onNavigate` callbacks across Overview, Earn, Borrow, and Positions.

4. **`apps/web/src/styles.css`**:
   - Added styles for `.portfolio-kpi-grid`, `.kpi-card`, `.category-pill-grid`, `.category-pill-card`, `.health-card-grid`, `.health-card`, `.performance-grid`, `.performance-card`, `.badge-neutral`, `.badge-success`, `.badge-warning`, `.badge-danger`, `.badge-info`, and `.disclosure-box`.
   - Maintained 100% compliance with WCAG 2.1 AA color contrast and `prefers-reduced-motion` requirements.

---

## 4. Verification Evidence

### 4.1 Test Execution

```bash
$ pnpm --filter @stacks-capital/web test
▶ web config
  ✔ starts on mainnet and can be pointed at testnet
  ✔ refuses an unknown network instead of picking one
  ✔ says testnet writes stay off
✔ web config
▶ Overview and Positions screens (I32)
  ▶ accounting consistency and non-double-counting
    ✔ excludes receipt tokens from total count and gross assets to prevent double-counting
    ✔ verifies accounting invariant: Gross Assets - Debt Liabilities = Net Worth
    ✔ handles partial valuation state consistently without suppressing verified subtotals
  ✔ accounting consistency and non-double-counting
  ▶ positions classification and action gating
    ✔ partitions positions correctly into supplied, collateral, and debt
  ✔ positions classification and action gating
  ▶ route and session persistence across reloads
    ✔ prefers URL search parameter ?tab=... over stored tab
    ✔ falls back to localStorage if URL does not specify tab
    ✔ defaults to Overview if neither URL nor storage specifies tab
    ✔ persists and restores wallet session per network
    ✔ handles corrupted storage gracefully
  ✔ route and session persistence across reloads
✔ Overview and Positions screens (I32)
▶ design system contrast
  ✔ declares every colour the pairs below are checked against
  ✔ meets WCAG 2.1 AA for normal text on every painted pair
  ✔ never paints plain white on the accent, which is below AA
  ✔ zeroes animation and transition for a reduced motion preference
✔ design system contrast
ℹ tests 16, suites 6, pass 16, fail 0
```

### 4.2 Quality Gates & Boundary Audits

- `pnpm format`: 301 files formatted cleanly.
- `pnpm boundaries`: Passed; 272 modules and 1006 dependencies cruised with 0 violations.
- `pnpm typecheck`: Passed cleanly across all 25 monorepo projects.
- `pnpm test:unit`: 440 tests passed across 144 suites.
- `pnpm test:checks`: 10 architectural boundary and lint tests passed.
- `pnpm sdk:check & pnpm sdk:compat`: 37 checks passed (10 functional checks, 27 compatibility checks).
- `pnpm gate:k38`: 11/11 passed.
- `pnpm gate:k39`: 23/23 passed.
- `pnpm gate:k40`: 18/18 passed.
