# Engineering Design & Verification: Exact-Input Swap and Routing Review Screen (I36)

## 1. Overview & Objectives

- **Task**: I36: Build exact-input Swap screen
- **Track**: Product
- **Priority**: P0
- **Dependencies**: I31, K29
- **Deliverables**:
  1. Render routes, expected/minimum output, impact, fees, and expiry.
  2. Support requote and recovery states.
- **Acceptance Evidence**:
  1. *Expired quotes cannot reach signing*.
  2. *Minimum output is enforced by the plan/contract call*.
  3. *Asset identifiers and decimals reconcile exactly*.

---

## 2. Architecture & Design

```
+-----------------------------------------------------------------------------+
|                           Swap Screen (apps/web)                            |
+-----------------------------------------------------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
                   v                                       v
      +-------------------------+             +-------------------------+
      | Direction & Input Entry |             |   Route Leg & Impact    |
      | - sBTC <-> USDCx toggle |             | - Bitflow DLMM router   |
      | - Exact human decimals  |             | - Contract & fn details |
      | - Base units preview    |             | - Multi-source impact   |
      | - Preset & custom slip  |             | - Tier: low/med/high    |
      +------------+------------+             +------------+------------+
                   |                                       |
                   +-------------------+-------------------+
                                       |
                                       v
         +-----------------------------------------------------------+
         |                 Strict Verification Gate                  |
         |  1. Reconcile assets & decimals (8 for sBTC, 6 for USDCx) |
         |  2. Verify onchain minimum output floor (args & deny PC)  |
         |  3. Real-time expiry clock: block if <= 15s or expired    |
         +-----------------------------------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
            [Signable]                             [Stale/Expired]
                   |                                       |
                   v                                       v
      +-------------------------+             +-------------------------+
      |    ReviewStateView      |             |  StaleDisputedStateView |
      | - Guaranteed min-out    |             | - Countdown warning     |
      | - Disclosed fees        |             | - Direct Requote CTA    |
      | - SDK offline validate  |             +-------------------------+
      | - Hand off to wallet    |
      +------------+------------+
                   |
                   v
      +-------------------------+
      |  Submission & Recovery  |
      | - SubmittedStateView    |
      | - FailedDelayedStateView|
      | - Scoped localStorage   |
      +-------------------------+
```

### 2.1 Asset Identification & Exact Decimal Reconciliation (`swapState.ts`)

1. **Canonical Asset Map**:
   - `sBTC`: 8 decimals. Canonical contract `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (mainnet) or `SN3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (testnet). Feed: `BTC/USD`.
   - `USDCx`: 6 decimals. Canonical contract `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token` (mainnet) or `ST120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx-token` (testnet). Feed: `USDC/USD`.
   - `STX`: 6 decimals. Canonical contract `native:stacks:stx`. Feed: `STX/USD`.

2. **String-Based Decimal Scaling**:
   - `toBaseUnits(displayAmount, decimals)`: Converts human strings (e.g. `"0.1"`) into exact integer base units (`"10000000"` for 8 decimals, `"100000"` for 6 decimals) without IEEE-754 floating point inaccuracies.
   - `fromBaseUnits(baseUnits, decimals)`: Formats base units into human decimal strings without precision loss.

3. **Reconciliation Invariant**:
   `reconcileSwapAssets(quote, network)` verifies that:
   - `input[0].asset` matches the expected input asset and contract deployment for the network.
   - `expectedOutput[0].asset` matches the expected output asset and contract deployment for the network.
   - Both assets have non-zero quantities and strictly conform to registered decimals.

### 2.2 Onchain Minimum Output Enforcement

`verifyMinimumOutputEnforcement(quote, plan)` verifies:
1. `quote.minimumOutput` is present, valid, and positive.
2. The router step call (`swap-x-for-y-simple-range-multi` or `swap-y-for-x-simple-range-multi`) includes the exact `minimumOutput.quantity` in its onchain arguments (`functionArgs`).
3. The post-conditions contain an asset transfer with `mode: "receive_gte"` protecting the receiver for at least `minimumOutput.quantity`.
4. `postConditionMode` is strictly `"deny"`.

If any of these conditions are missing or tampered with, `enforced: false` is returned, and signing is blocked.

### 2.3 Expiry & Requote Guard

1. Expiry clock computes `expiresInSeconds = floor((expiresAt - now) / 1000)` every second.
2. If `expiresInSeconds <= 0`: marked `expired: true`.
3. If `expiresInSeconds <= 15`: marked `needsRefresh: true`.
4. `isQuoteSignable(view, quoted, now)` rejects any quote where `expired === true` or `needsRefresh === true`.
5. The review UI replaces the approval trigger with `StaleDisputedStateView`, rendering an explicit `Requote` action.

### 2.4 Workflow Recovery & Scoped Storage

- Persistent recovery across browser reloads: Pending and submitted workflows are saved to `localStorage` under `capital_os_swap_workflow_${network}_${wallet.address}`.
- If the wallet rejects or aborts, the error is caught and displayed cleanly.
- If the broadcast is unconfirmed or returns no txid, `FailedDelayedStateView` is rendered with the workflow ID and a one-click copy button, advising the user that nothing is retried automatically.
- Once submitted, `SubmittedStateView` tracks the Hiro Explorer link and workflow progress.

---

## 3. Verification & Automated Test Coverage

### 3.1 Unit Test Suites (`apps/web/src/swapScreen.test.ts`)

- **Decimal Conversion Precision**:
  - Validates exact 8-decimal and 6-decimal scaling without floating-point errors.
- **Asset & Decimal Reconciliation (AE3)**:
  - Validates canonical sBTC and USDCx reconcile with 8 and 6 decimals on mainnet and testnet.
  - Rejects unknown or unverified contract addresses.
- **Minimum Output Onchain Enforcement (AE2)**:
  - Validates router argument and deny-mode post-condition matching.
  - Fails closed when router arguments do not match the quote floor or when minimum output is missing.
- **Expiry and Requote Guards (AE1)**:
  - Permits signing when validity $> 15$ seconds.
  - Blocks signing when within refresh margin ($\le 15$ seconds).
  - Blocks signing when quote is expired ($\le 0$ seconds).
  - Formats countdown statuses accurately.
- **Price Impact Tiers**:
  - Classifies low (<100 bps), medium (100–300 bps), and high (>300 bps) impact tiers.

### 3.2 System & Quality Checks

```bash
pnpm format && pnpm boundaries  # Biome formatting and dependency-cruiser boundaries PASS
pnpm test:unit && pnpm test:checks # 468 unit tests across all packages PASS
pnpm typecheck                  # All 25 tsconfig projects PASS
pnpm sdk:check && pnpm sdk:compat # 10 SDK checks + 27 SDK compat checks PASS
pnpm gate:k38 && pnpm gate:k39 && pnpm gate:k40 # Release gates PASS
```
