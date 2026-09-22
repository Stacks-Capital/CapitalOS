# Engineering Design & Verification: Liquidity Provision and Staking Screens (I37)

## 1. Overview & Objectives

- **Task**: I37: Build liquidity provision and staking screens
- **Track**: Product (P1)
- **Dependencies**: I31, K30, K31, K32, K33
- **Deliverables**:
  1. Implement LP add/remove/fee collection interfaces.
  2. Implement verified staking/unstaking/claim interfaces and unavailable states.
- **Acceptance Evidence**:
  1. *LP screens disclose range/bin, IL exposure and exit liquidity*.
  2. *Staking distinguishes Bitcoin, STX and protocol receipt staking*.
  3. *Unsupported capabilities never appear executable*.

---

## 2. Architecture

### 2.1 Liquidity Provision

```
+------------------------------------------------------------------+
|             LiquidityScreen (apps/web/src)                        |
+------------------------------------------------------------------+
         |                    |                    |
         v                    v                    v
+------------------+ +------------------+ +------------------+
| Pool Overview    | | Range & Bin      | | IL Exposure      |
| - Pair / Fee     | | - Track / Bounds | | - CPMM formula   |
| - TVL / Status   | | - Bin / Step     | | - 8 presets      |
| - Capability     | | - In/Out range   | | - Limitations    |
+------------------+ +------------------+ +------------------+
         |                    |                    |
         v                    v                    v
+------------------+ +------------------+ +------------------+
| Exit Liquidity   | | Actions          | | LP Accounting    |
| - Reserves       | | - Add/Remove/Fee | | - Share / Pooled |
| - Lock type      | | - B6 gate        | | - Unclaimed fees |
| - Slippage est.  | | - UnsupportedView| | - Base unit math |
+------------------+ +------------------+ +------------------+
```

#### Capability Gating (Pilot Blocker B6)

`ALLOWED_POOL_PRINCIPALS` (local mirror of `BITFLOW_ALLOWED_POOLS` in `@stacks-capital/config`) is currently empty. This means:
- All LP actions return `executable: false` with reason "Pilot Blocker B6".
- The `LiquidityScreen` renders pool info, IL calculator, and exit liquidity disclosures but never allows any executable LP operations.
- When pools are pinned, the screen transitions to the full add/remove/claim workflow.

#### Impermanent Loss Calculation

Standard CPMM formula: `IL(k) = 2√k / (1+k) - 1`, where `k = P₁/P₀`.

- 8 preset divergence scenarios: ±5%, ±10%, ±25%, ±50%.
- Discloses formula, assumptions, and limitations (DLMM concentrated bins may amplify IL).
- IL values are computed client-side as informational estimates only.

#### LP Accounting

- Pool share: `(userLpTokens * 10000) / totalLpTokens` bps.
- Pooled assets: `(reserveX * userLpTokens) / totalLpTokens`.
- All arithmetic uses `bigint` to avoid IEEE-754 precision loss.

### 2.2 Staking

```
+------------------------------------------------------------------+
|               StakingScreen (apps/web/src)                        |
+------------------------------------------------------------------+
         |                    |                    |
         v                    v                    v
+------------------+ +------------------+ +------------------+
| Native Bitcoin   | | STX Stacking     | | Protocol Receipt |
| (PoX)            | | (StackingDAO)    | | (Hermetica)      |
| - L1 lock        | | - stSTX receipt  | | - sUSDh receipt  |
| - K16 disabled   | | - 14-day cool    | | - Vault custody  |
| - pox-5 contract | | - provider APY   | | - provider rate  |
+------------------+ +------------------+ +------------------+
         |                    |                    |
         +--------------------+--------------------+
                              |
                 K33 Invariant: All routes are
                 `executable: false` with documented
                 distinctions and reasons
```

#### Three-Category Taxonomy

| Category | Protocol | Asset | Receipt | Custody Model | Status |
|----------|----------|-------|---------|---------------|--------|
| `native_bitcoin` | pox | BTC (L1) | — | L1 Bitcoin Consensus | Disabled (K02/K16) |
| `stx_stacking` | stackingdao | STX | stSTX | Smart Contract Lock | Unavailable |
| `protocol_receipt` | hermetica | USDH | sUSDh | Escrow Vault | Unavailable |

#### K33 Invariant Enforcement

Every `StakingRouteView` exposes:
- `executable: false` and `broadcastAllowed: false`
- Explicit `capabilityReason` with K-reference
- `distinctions[]` documenting what this route is NOT
- Provider-reported yield provenance labeled as `"provider_reported"` confidence

#### Architectural Boundary Compliance

Per `scripts/checks/architecture.ts` line 67, `apps/web` uses public packages only (`core`, `sdk`, `client`, `wallets`, `react`, `ui`). Neither `liquidityState.ts` nor `stakingState.ts` imports from `@stacks-capital/config` or `@stacks-capital/adapters`. Pool allowlists and staking availability are self-contained.

---

## 3. Files

| File | Purpose |
|------|---------|
| `apps/web/src/liquidityState.ts` | Pure LP types, IL calculation, accounting, capability gating |
| `apps/web/src/liquidityScreen.tsx` | LP screen component with pool overview, range/bin, IL calculator, exit liquidity |
| `apps/web/src/liquidityScreen.test.ts` | 17 unit tests for LP logic |
| `apps/web/src/stakingState.ts` | Pure staking types, route views, K33 invariant |
| `apps/web/src/stakingScreen.tsx` | Staking screen component with three category sections |
| `apps/web/src/stakingScreen.test.ts` | 17 unit tests for staking logic |
| `apps/web/src/app.tsx` | Wired LiquidityScreen and StakingScreen in place of static UnsupportedStateView |
| `apps/web/src/styles.css` | CSS for LP pool overview, range/bin bar, IL calculator, staking route cards, category badges |

---

## 4. Verification Evidence

### K30 (Bitflow liquidity lifecycle)
- `ALLOWED_POOL_PRINCIPALS` is empty → no LP action is executable
- `isLpActionExecutable` returns `false` for all pools and networks
- `buildPoolView` always produces `capabilityState: "unavailable"`

### K31 (Hermetica staking and reward lifecycle)
- Hermetica route has `executable: false`, `broadcastAllowed: false`
- Exchange rate and rewards provenance are labeled `"provider_reported"`
- Distinctions document that sUSDh is a yield vault receipt, not staking

### K33 (Stacking and staking capability routes)
- Native Bitcoin staking is disabled with K02/K16 reason
- All four K33 distinctions from the adapters package are reproduced
- `isStakingSignable` refuses signing for every route
- `zsBTC` is documented as not a staking position

### Release Gates
- All 34 new tests pass (17 LP + 17 staking)
- Architectural boundary: no imports from config, adapters, engine, database, fixtures
- Typecheck, lint, and full test suite verified
