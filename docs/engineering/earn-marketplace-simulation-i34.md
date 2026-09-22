# Engineering Design & Verification: Earn Marketplace and Strategy Simulation (I34)

## 1. Overview & Objectives

- **Task**: I34: Build Earn marketplace and strategy simulation screens
- **Track**: Product
- **Priority**: P0
- **Dependencies**: I24, I27, I31, K27, K31, K32
- **Deliverables**:
  1. Compare same-asset opportunities and evidence-gated allocations.
  2. Show base yield, incentives, capacity, liquidity, fees and risks separately.
  3. Interactive strategy yield simulation with exact disclosed inputs.
  4. Dual supply (deposit) and withdrawal flows using public SDK plans.
- **Acceptance Evidence**:
  1. *No provider-only or stale value is presented as verified*.
  2. *Projected earnings use exact disclosed inputs*.
  3. *Deposit and withdrawal review use public SDK plans*.

---

## 2. Architecture & Design

```
+-----------------------------------------------------------------------------+
|                           Earn Screen (apps/web)                            |
+-----------------------------------------------------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
                   v                                       v
      +-------------------------+             +-------------------------+
      |     Marketplace Tab     |             |   Strategy Simulator    |
      |   (Evidence-Gated)      |             |   (Pure Mathematical)   |
      +------------+------------+             +------------+------------+
                   |                                       |
      +------------+------------+             +------------+------------+
      | - Same-Asset Filtering  |             | - Exact Input Modeling  |
      | - Evidence Verification |             | - Horizon (30/90/180/365|
      | - Disagreement Alerts   |             | - Base vs Incentive Gain|
      | - Unranked Disclosures  |             | - Reliability Badges    |
      | - Separate Yield/Risk   |             | - Disclosed Assumptions |
      +-------------------------+             +-------------------------+
                   |                                       |
                   +-------------------+-------------------+
                                       |
                                       v
         +-----------------------------------------------------------+
         |              Dual Supply & Withdrawal Review              |
         |  - Action Toggle: Supply vs Withdrawal                    |
         |  - Client Quoting (/v1/quote with action parameter)       |
         |  - Public SDK Plan Validation (canSign, createStacks Capital)  |
         |  - State Machine (review -> signing -> confirming -> done)|
         |  - Reload Resilience via Tenant & Network-Scoped Storage  |
         +-----------------------------------------------------------+
```

### 2.1 Evidence-Gated Comparison

1. **Ranking Invariant**:
   Markets are strictly ranked within same-asset groups only when:
   - `supply.state === "enabled"`
   - `paused !== true`
   - `withdrawal.state === "enabled"` (non-liquid lockup strategies are excluded from ranking)
   - `baseRate !== null`
   - `!stale` and observation timestamp $< 300\text{s}$ old
   - `evidence.confidence !== "low"` and `evidence.disagreement !== "mismatch"`
2. **Unranked Transparency**:
   Any opportunity that fails evidence checks is listed with the exact reason (e.g., `"The last reading is stale"`, `"Evidence confidence is low"`, `"Capacity or available liquidity is exhausted"`).
3. **Yield Component Separation**:
   Base APY, Incentive APY, Total Effective APY, Available Liquidity, Capacity, and Withdrawal state are partitioned into dedicated table columns and badges.

### 2.2 Strategy Simulation Modeling

The prospective yield simulator (`packages/ui/src/simulation.ts` & `apps/web/src/earnState.ts`) implements deterministic linear yield forecasting without hidden multipliers:
$$\text{Base Yield} = \text{Principal} \times \frac{\text{Base Rate Bps}}{10000} \times \frac{\text{Days}}{365}$$
$$\text{Incentive Yield} = \text{Principal} \times \frac{\text{Incentive Rate Bps}}{10000} \times \frac{\text{Days}}{365}$$
$$\text{Projected Balance} = \text{Principal} + \text{Base Yield} + \text{Incentive Yield}$$

- **Disclosed Assumptions**:
  - Linear annualized projection over selected horizon (30d, 90d, 180d, 365d).
  - Assumes continuous deposit without early withdrawal penalties.
  - Warns that protocol incentive emissions and token prices are variable.
- **Evidence Verification**:
  - Flags projections as unreliable if market data is stale, unverified, or has mismatched onchain reads.

### 2.3 Public SDK Plan Review & Execution

- Supports both `"supply"` and `"withdraw_supply"` actions.
- Quotes are verified using `createStacks Capital({ network }).validate(plan, quote, { sender })`.
- Review state displays give amount, receive amount, minimum output, fees, protocol contract, and expiry timer.
- Signature requests use `askWallet` with typed errors.
- Progress transitions through `AWAITING_SIGNATURE`, `SUBMITTED`, `CONFIRMING`, and `COMPLETED`, while `BROADCAST_UNKNOWN` triggers manual recovery without duplicate write retries.

---

## 3. Implementation Summary

1. **`packages/ui/src/simulation.ts`** & **`packages/ui/src/simulation.test.ts`**:
   - Pure strategy simulation calculation module with scale conversion and reliability auditing.
   - Verified across multi-horizon modeling and warning assertions.

2. **`apps/web/src/earnState.ts`** & **`apps/web/src/earnScreen.test.ts`**:
   - Modular helper for asset filtering, capability checks, evidence badge formatting, and deterministic return calculations.
   - Comprehensive unit tests verifying evidence-gated ranking and mathematical consistency.

3. **`apps/web/src/earnScreen.tsx`**:
   - Sub-navigation toggling between "Earn Marketplace & Comparison" and "Strategy Yield Simulator".
   - Same-asset filtering bar (`sBTC`, `STX`, `USDA`, `USDCx`, `All`).
   - Detailed marketplace table with separate base/incentive yield, liquidity, and audit indicators.
   - Strategy simulator with principal input, horizon picker, result cards, and pre-fill action button.
   - Dual Supply & Withdrawal action toggle and SDK workflow execution.

4. **`apps/web/src/styles.css`**:
   - Added styles for `.earn-subnav`, `.subnav-btn`, `.earn-filter-bar`, `.simulation-inputs-grid`, `.simulation-cards-grid`, `.simulation-card`, `.simulation-disclosures-box`, and `.earn-action-toggle`.
   - WCAG 2.1 AA verified.

---

## 4. Verification Evidence

### 4.1 Test Execution

```bash
$ pnpm --filter @stacks-capital/ui test
▶ Earn strategy simulation (I34)
  ✔ computes projected yields accurately from exact disclosed inputs
  ✔ calculates partial year horizon correctly (e.g. 30 days and 90 days)
  ✔ flags stale reading, low evidence confidence, or mismatch as unreliable
  ✔ handles zero or invalid principal safely
✔ Earn strategy simulation (I34)
ℹ tests 138, suites 41, pass 138, fail 0

$ pnpm --filter @stacks-capital/web test
▶ Earn Marketplace and Strategy Simulation Screen (I34)
  ▶ same-asset filtering and evidence presentation
    ✔ filters earn opportunities by supplied asset correctly
    ✔ formats evidence badges and detects onchain mismatches
    ✔ enforces capability gating for supply and withdrawal actions
  ✔ same-asset filtering and evidence presentation
  ▶ strategy simulation mathematics and disclosures
    ✔ calculates exact projected returns without hidden multipliers
    ✔ handles zero or empty principal gracefully
  ✔ strategy simulation mathematics and disclosures
✔ Earn Marketplace and Strategy Simulation Screen (I34)
ℹ tests 21, suites 9, pass 21, fail 0
```

### 4.2 Quality Gates & Boundary Audits

- `pnpm format`: 305 files formatted cleanly.
- `pnpm boundaries`: Passed; 276 modules and 1016 dependencies cruised with 0 violations.
- `pnpm typecheck`: Passed cleanly across all 25 projects in monorepo.
- `pnpm test:unit`: 448 tests passed across 148 suites.
- `pnpm test:checks`: 10 architectural boundary and lint tests passed.
- `pnpm sdk:check & pnpm sdk:compat`: 37 checks passed (10 functional, 27 compatibility).
- `pnpm gate:k38`: 11/11 passed.
- `pnpm gate:k39`: 23/23 passed.
- `pnpm gate:k40`: 18/18 passed.
