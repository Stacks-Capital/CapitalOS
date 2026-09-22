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
Playwright runs against the real API on an isolated seeded schema, with market reads served from
fixtures. Two profiles are configured in `apps/e2e/playwright.config.ts`:
1. **Desktop Chrome**: `1280x800` viewport, full keyboard navigation, focus trap verification in workflow drawer.
2. **Mobile (Pixel 7)**: `412x915` viewport, touch targets, horizontal overflow assertion (`scrollWidth <= innerWidth`) across every screen.

**Both profiles are Chromium.** Firefox and WebKit are not exercised, so no Safari or Firefox
evidence exists. The supported browser matrix required by the P3 gate is therefore **not complete**,
and the supported set must be declared as Chromium-only or the missing engines added before launch.

### 2.2 Wallet Provider Matrix
- **Provider**: a stand-in for Leather, in `apps/e2e/tests/wallet.ts`, injected at
  `window.LeatherProvider.request` where the app looks for the real one. It signs with a real
  secp256k1 key in the test process, so the API verifies a genuine signature, but **no released
  Leather or Xverse build is exercised.** Real-wallet evidence is still outstanding.
- **Signature Modes**: `stx_signMessage`, contract call intents (`stx_callContract`), rejection
  handling, and malformed responses (`no-txid` missing hash).
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

### 4.1 Telemetry that exists today
The worker exposes an HTTP surface in `apps/worker/src/health.ts`, and that is the whole of the
telemetry this release ships:

| Endpoint | Reports |
|---|---|
| `GET /health`, `GET /livez` | Process liveness only. |
| `GET /readyz` | Database reachability; 503 when the connection fails. |
| `GET /status` | Ingestion checkpoint height, hash and timestamp, and an `ok` / `degraded` / `unhealthy` roll-up; 503 when unhealthy. |

There is no metrics exporter, no dashboard and no alert router in this repository. Anything that
scrapes, charts or pages on these endpoints is deployment infrastructure that has not been built
or verified, and no pilot may assume it. **This is an open gap against the P3 requirement to verify
monitoring dashboards and alerts, and it is not closed by this task.**

### 4.2 Protective behaviour that exists today
There is no automatic quotation freeze. Protection is per-asset and per-capability instead:

- **Price quorum fails closed per asset.** `valuePosition` in `packages/core/src/valuation.ts`
  withholds the price entirely (`price: null`, `disagreement: true`) when independent sources
  disagree by more than `DEFAULT_MAX_QUORUM_SPREAD_BPS`, which is **300 bps**. Unrelated assets
  keep their verified values.
- **Stale or disputed oracles block borrow actions.** `isActionSafeToProceed` in
  `apps/web/src/borrowState.ts` refuses to request a quote when either oracle is stale or in
  disagreement.
- **Stale market evidence cannot rank.** `compareEarn` in `packages/ui/src/compare.ts` refuses to
  rank a reading older than `EARN_OPTION_MAX_AGE_MS` (300 seconds).
- **Capabilities are paused by hand, not automatically.** `pnpm ops:pause` and `pnpm ops:disable`
  move a market action to `paused` or `disabled`; exit capabilities survive a write pause by
  design. See `apps/worker/src/ops.ts`.

### 4.3 Runbooks & Outage Procedures
Runbooks reviewed for this task, in `docs/runbooks/` and `docs/engineering/operations.md`:
  - `backup-restore.md`: database restore and worker catch-up.
  - `rollback.md`: release rollback and registry rollback.
  - `incidents.md`: severity scale, reorg replay and market pausing.

Drill evidence for restore and rollback is K38's, recorded in `docs/release/evidence/`, and is not
reproduced here.

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
