# Engineering Design & Verification: Risk, Alerts and Activity Screens (I38)

## 1. Overview and Objectives

- **Task**: I38: Build Risk, Alerts and Activity screens
- **Track**: Product (P0)
- **Dependencies**: I31 (Shell & Design System), K36 (Risk Engine & Protective Action Semantics)
- **Deliverables**:
  1. Provide plain-language and advanced risk modes (`apps/web/src/riskScreen.tsx`, `apps/web/src/riskState.ts`).
  2. Group activity by durable workflows with recovery actions (`apps/web/src/activityScreen.tsx`, `apps/web/src/activityState.ts`).
  3. Provide client-side advisory alerts with explicit user consent and delivery limitation disclosures.
- **Acceptance Evidence**:
  1. *Risk numbers expose meaning, source, timestamp and calculation version (`risk@1.0.0`)*.
  2. *BTC stress scenarios state assumptions and coverage*.
  3. *Alerts disclose delivery limitations and consent*.

---

## 2. Architecture & Design Principles

### 2.1 Dual-Mode Risk Presentation (Plain vs Advanced)

Users can toggle between two synchronized presentation modes via the shell `ScreenHeader` (`mode: ViewMode`):
- **Plain-Language Mode**:
  - Summarizes credit health with clear status indicators: `"Safe (No Debt Opened)"`, `"Healthy Position"`, `"Liquidation Danger"`, or `"Telemetry Stale"`.
  - Interprets Granite health into natural language using `interpretGraniteHealth(health, params).meaning`.
  - Simplifies KPI metrics into high-level cards (Health Factor, Current LTV, Safety Buffer).
  - Presents actionable protective recommendations (e.g. `"SUPPLY: Adding isolated sBTC collateral is supported when the oracle is fresh"`, `"REPAY: Repay reduces debt and is the primary protective action"`).
- **Advanced Mode**:
  - Exposes raw mathematical parameters, basis points (`bps`), and exact underlying decimals.
  - Displays full `RiskMetricView` cards exposing metadata attributes for every figure:
    - `meaning`: Clear contextual definition of the metric.
    - `source`: Specific oracle contract or pool feed (e.g., Pyth Hermes, Redstone, Granite Isolated Pool Contract).
    - `timestamp`: Verified observation timestamp (`observedAt`).
    - `calculationVersion`: Canonical calculation engine version identifier (`risk@1.0.0`).
    - `status`: Verification status (`fresh`, `stale`, `disputed`).

### 2.2 BTC Collateral Stress Scenarios

Collateral price shocks are simulated using core's certified `stressGraniteCollateral` across symmetric stress tiers:
$$\Delta P \in \{-5\%, -10\%, -20\%, -30\%, -50\%\}$$

#### Stated Assumptions and Coverage
- **Coverage**: Isolated Granite sBTC / USDCx credit market.
- **Assumptions**:
  1. Only the collateral oracle price moves by the declared basis point shift.
  2. Borrowed USDCx debt, accrued interest, and protocol risk parameters ($LTV_{\text{borrow}}$, $LTV_{\text{liq}}$) are held constant.
  3. Liquidation status is evaluated strictly against the verified on-chain threshold $LTV_{\text{liq}} = 80\%$.
- **Fail-Closed Stale Oracle Handling**:
  - If collateral or debt oracle telemetry is stale ($> 180$s) or has quorum disputes, all stress scenario rows are withheld (`health: null`, `unavailableReason: "Oracle is stale"`). Scenarios never invent prices or project false safety.

### 2.3 Advisory Alerts & Delivery Limitations

Health alerts allow users to receive real-time notifications when their position health factor approaches liquidation.

#### Invariant: Explicit Consent & Delivery Disclosures
Decentralized client architectures do not maintain custodial push servers. Alerts run client-side in the browser:
1. **Explicit User Consent**: Alerts default to disabled (`enabled: false`, `limitationsAcknowledged: false`). Users must actively opt in and grant browser notification permissions.
2. **Delivery Limitations Disclosure**:
   - *Client-Side Only*: Active browser tab execution; closed or throttled tabs cannot guarantee notification delivery.
   - *Network & Latency Dependencies*: Notifications depend on RPC polling intervals and network reachability.
   - *Advisory Invariant*: Alerts do not automate transactions and cannot prevent smart contract liquidations.

### 2.4 Durable Workflows & Recovery Actions

Activity is organized around durable multi-step workflows (`apps/web/src/activityScreen.tsx`, `apps/web/src/activityState.ts`):
- **Lifecycle Grouping**:
  - **In Progress (`active`)**: Workflows currently executing or confirming on-chain (`submitted`, `confirming`, `mint_pending`, `awaiting_signature`).
  - **Needs Recovery (`recovery_needed`)**: Stalled, delayed, or failed workflows (`reclaimable`, `delayed`, `expired`, `failed`).
  - **Completed (`completed`)**: Fully verified and reconciled workflows (`reconciled`, `completed`, `settled`).
- **Certified Recovery Actions**:
  - `reclaim`: Triggers atomic lock-height Bitcoin refund for delayed sBTC deposits.
  - `requote`: Rebuilds plans when swap or borrow pricing expires.
  - `retry`: Re-attempts failed transaction broadcasts with verified nonces.
  - `resume`: Continues pending multi-step workflows.
  - `view_proof`: Deep links to the Stacks explorer to inspect canonical block inclusion.

---

## 3. Verification & Conformance Evidence

### Automated Unit Test Suites
1. **Risk & Alerts State Suite** (`apps/web/src/riskScreen.test.ts`):
   - Verified that every risk metric exposes `meaning`, `source`, `timestamp`, and `calculationVersion` (`risk@1.0.0`).
   - Verified that BTC stress scenarios disclose stated assumptions and single-asset coverage.
   - Verified fail-closed behavior on stale or disputed oracles.
   - Verified alert consent opt-in rules and delivery limitation acknowledgment.
2. **Activity & Durable Workflows Suite** (`apps/web/src/activityScreen.test.ts`):
   - Verified grouping into `active`, `recovery_needed`, and `completed`.
   - Verified recovery action resolution (`reclaim`, `requote`, `retry`, `resume`, `view_proof`).
   - Verified action and status formatting.
