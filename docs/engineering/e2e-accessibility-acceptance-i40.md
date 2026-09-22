# Engineering Design & Verification: Product E2E, Accessibility and Operational Acceptance (I40)

## 1. Overview & Objectives

- **Task**: I40: Run product E2E, accessibility and operational acceptance
- **Track**: Release
- **Priority**: P0
- **Lead / Reviewer**: IBK / Kenzman
- **Goal**: Execute comprehensive end-to-end user journeys, rigorous WCAG 2.1 AA accessibility scans across all 10 canonical application tabs, verify wallet and mobile responsive matrices, and validate production operational runbooks and monitoring telemetry.

---

## 2. Test Architecture & Coverage Matrix

### 2.1 Browser & Device Profiles
Testing is executed under Playwright with real browser engines against isolated sandbox database instances and an authentic JSON-RPC wallet provider:
1. **Desktop Chrome**: `1280x800` viewport, full keyboard navigation, focus trap verification in workflow drawer.
2. **Mobile (Pixel 7)**: `412x915` viewport, touch targets, horizontal overflow assertion (`scrollWidth <= innerWidth`) across every screen.

### 2.2 Wallet Provider Matrix
- **Provider Protocol**: Leather / Xverse JSON-RPC Stacks standard provider (`window.LeatherProvider` / `window.StacksProvider`).
- **Signature Modes**: Real cryptographic curve signatures (`stx_signMessage`), contract call intents (`stx_callContract`), rejection handling, and malformed responses (`no-txid` missing hash).
- **Session Lifecycle**: Multi-account isolation (`wallet.switchAccount()`), mid-flight reloads returning to unfinished workflow step, and explicit disconnection session teardown.

### 2.3 Ten Canonical Screens Accessibility Audit (WCAG 2.1 AA)
Axe-core automated accessibility audits inspect both signed-in and signed-out states across all 10 canonical tabs:
1. **Overview**: Portfolio summary, net asset calculations, valuation coverage disclosures, category deployment breakdown.
2. **Deposit BTC**: Direct L1 Bitcoin deposit notice, distinct locked accounting, sBTC withdrawal quote and execution.
3. **Earn**: Verified yield marketplace, simulated yield calculations, quote request countdown, vault supply submission.
4. **Borrow**: Granite protocol debt markets, collateral ratio disclosures, borrow quote execution.
5. **Swap**: Bitflow DLMM DEX routing, slippage tolerance presets, on-chain min-out enforcement, price impact telemetry.
6. **Liquidity**: DLMM pool liquidity provision, fee tier selectors, impermanent loss risk disclosures.
7. **Staking**: Categorized staking routes (L1 PoX Bitcoin, liquid STX stacking, protocol receipt staking), custody and unbonding period disclosures, unverified signing route safeguards.
8. **Positions**: Decoded multi-protocol positions, underlying asset breakdowns, exit liquidity routing.
9. **Risk**: Credit health telemetry, collateral stress scenario projections, Granite advisory alerts and consent.
10. **Activity**: Durable workflow execution logs, broadcast transaction IDs, explorer links, recovery states.

---

## 3. Automated Journey Scenarios

| Journey Scenario | Description & Invariant | Status |
|---|---|---|
| **Happy Supply** | Signs in, requests vault supply quote, signs transaction, asserts `SUBMITTED` status and contract call sequence. | **PASSED** |
| **Rejection Handling** | Rejection in wallet emits actionable warning and leaves workflow step resumable without duplicate intent. | **PASSED** |
| **Recovery on Malformed Tx** | Wallet response lacking `txid` diverts safely to recovery view with idempotency protection, preventing double-spend. | **PASSED** |
| **Reload Persistence** | Reloading during pending wallet signature resumes directly at the unfinished step. | **PASSED** |
| **Account Isolation** | Switching wallet accounts ensures the new address cannot inspect or submit the prior account's unfinished step. | **PASSED** |
| **Quote Expiry** | Simulating quote deadline expiration triggers stale quote state and presents fresh quote refresh action. | **PASSED** |
| **Service Outage Resiliency** | Backend 503 outage displays clear, actionable error banner rather than unhandled crash or white screen. | **PASSED** |
| **Partial Data Disclosure** | Unpriced or unverified collateral items display valuation coverage warnings and conservative totals. | **PASSED** |
| **Swap Routing & Min-Out** | Quotes Bitflow AMM routing, displays route hops, enforces minimum output post-conditions on-chain. | **PASSED** |
| **Risk Scenarios & Consent** | Toggles standard vs pro telemetry, executes collateral price shock simulations, captures advisory consent. | **PASSED** |
| **Keyboard Accessibility** | Full keyboard traversal (`Tab` / `Shift+Tab` / `Enter` / `Space`), focus trap in workflow drawer, `Escape` dismissal. | **PASSED** |
| **Mobile Viewport Overflow** | No horizontal scrolling (`scrollWidth == innerWidth`) across all 10 tabs on mobile devices. | **PASSED** |

---

## 4. Operational Acceptance & Monitoring Verification

### 4.1 Production Dashboards & Telemetry
- **Prometheus Metrics**: Ingestion pipeline lag, oracle quorum consensus health, quote generation latency (P95/P99), workflow terminal status rates.
- **Circuit Breakers**: Automatic quotation freeze when oracle quorum drops below threshold ($M \ge 2$) or spread diverges beyond 200 bps.

### 4.2 Runbooks & Outage Procedures
- Production runbooks verified in `docs/runbooks/` and `docs/engineering/operations.md`:
  - Worker crash and state recovery from PostgreSQL durable log.
  - RPC endpoint failover and block reorganization re-indexing.
  - Stale oracle recovery and emergency market pausing.

---

## 5. Verification Commands

```bash
# Execute browser test suite (Playwright: Desktop Chrome + Mobile)
pnpm test:browser

# Execute workspace unit test suites
pnpm test:unit

# Architectural boundary verification
pnpm boundaries

# Typecheck all workspace packages
pnpm typecheck

# Code style and linter verification
pnpm lint

# Monorepo release gates
pnpm gate:k38 && pnpm gate:k39 && pnpm gate:k40
```
