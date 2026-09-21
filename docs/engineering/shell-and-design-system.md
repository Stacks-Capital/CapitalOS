# Everything Stacks shell and design system

| | |
|---|---|
| Task | I31 Implement the Everything Stacks shell and design system |
| Requirements | UI-01, UI-02, UI-03, UI-04, A11Y-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I01 web app foundation, I09 wallet session, wireframes |
| Date | 2026-09-21 |

Deliverable from the task page: implement the responsive Everything Stacks shell, unified navigation matching the product wireframes, the workflow drawer, a centralized implementation of the eight canonical states, Simple/Pro view modes, and complete accessibility compliance (WCAG 2.1 AA).

## Shell structure and navigation

The application layout reflects the `everything.stacks` product wireframes (`landing.png`, `overview.png`):

| Element | Description | Implementation |
|---|---|---|
| Brand | `everything.stacks` wordmark linking to home / overview | `ShellHeader` in `@stacks-capital/ui` |
| Network indicator | Current network badge (`mocknet` / `testnet` / `mainnet`) | Header status badge |
| Block height | Current block height chip with live visual indicator | `BlockHeightChip` |
| Address chip | Truncated address (`SP2C2Y…9YZR`) with click-to-copy, feedback tooltip, and live region | `AddressChip` in `@stacks-capital/ui` |
| Connect / Disconnect | Session management with wallet selection dropdown or disconnect action | Primary header action |
| Navigation tabs | 10 wireframe views (`Overview`, `Deposit BTC`, `Earn`, `Borrow`, `Swap`, `Liquidity`, `Staking`, `Positions`, `Risk`, `Activity`) | `ShellNavigation` with responsive horizontal scroll and aria-current |
| Screen header | Title, contextual subtitle, and Simple / Pro mode toggle | `ScreenHeader` with `<fieldset>`-based `SimpleProToggle` |
| Workflow drawer | Centralized slide-out drawer accessible from any screen | `WorkflowDrawer` with focus restoration, Tab trap, and Escape key handling |
| Live announcer | Live region for screen readers announcing the latest workflow progress | `WorkflowAnnouncer` mounted permanently in the DOM root |

## Centralized eight canonical states

Every one of the eight canonical states is implemented once in `@stacks-capital/ui/states.tsx` with shared types in `state.ts`, and adopted directly by the application screens:

| State | Kind | Implemented In | Screen Adoption | Fallback & Fail-Closed Behavior |
|---|---|---|---|---|
| 1. Loading | `loading` | `LoadingStateView` | Portfolio positions load | Shows what is loading; offers retry; stable layout |
| 2. Empty | `empty` | `EmptyStateView` | Portfolio (signed out), Swap (signed out) | Explains prerequisite; offers connect / sign in action |
| 3. Partial | `partial` | `PartialStateView` | Portfolio holdings | Verified subtotal rendered; excluded positions and reasons named explicitly via `excludedFrom` |
| 4. Unsupported | `unsupported` | `UnsupportedStateView` | Deposit BTC, Liquidity, Staking | Names unbacked asset/protocol; executable controls disabled; fails closed |
| 5. Stale / Disputed | `stale_disputed` | `StaleDisputedStateView` | Earn (expired quote), Swap (expired/expiring quote) | Age and sources displayed; signing disallowed; requires refresh/requote |
| 6. Review | `review` | `ReviewStateView` | Earn (valid quote), Swap (valid quote) | Full fee and impact breakdown; signing disabled until server plan validation passes |
| 7. Submitted | `submitted` | `SubmittedStateView` | Earn (broadcast), Swap (broadcast) | Txid, Hiro explorer link, and confirmed vs reconciled explanation |
| 8. Failed / Delayed | `failed_delayed` | `FailedDelayedStateView` | Earn (unknown broadcast), Swap (unknown broadcast) | Plain language cause, location of funds, and non-destructive recovery actions |

## Responsive table and accessibility contract (WCAG 2.1 AA)

### 1. Table to card reflow (`packages/ui/src/table.tsx`)
Below 768px, CSS switches tables to `display: block` to render responsive cards. Because browsers derive table semantics from computed display styles, switching to block strips the implicit `table`, `row`, and `cell` roles from the accessibility tree. `ResponsiveTable` writes explicit ARIA roles (`role="table"`, `role="row"`, `role="cell"`, `role="columnheader"`) with `data-label` attributes on every cell so card reflow preserves accessibility semantics.

### 2. Verified color contrast (`apps/web/src/styles.test.ts`)
- Text tokens (`--text-primary: #f0f6fc`, `--text-secondary: #b1bcc7`, `--text-muted: #9ba7b4`) exceed 4.5:1 against card backgrounds (`#161b22`, `#21262d`).
- Button labels on the primary accent (`#ff5533`) use dark token `--on-accent: #150903` (contrast 6.8:1), eliminating contrast failures present with pure white.
- `apps/web/src/styles.test.ts` parses the real stylesheet and mathematically verifies WCAG 2.1 AA contrast for every painted foreground/background pair.

### 3. Keyboard navigation and modal focus
- Visible focus rings: Universal `:focus-visible` with 2px solid accent and 2px offset.
- Skip link: Accessible top-level skip link jumping to `#main-content`.
- Workflow drawer: Stores the previously focused element (`returnFocusRef`), shifts focus to the close button on open, traps `Tab` navigation within modal boundaries, and dismisses on `Escape` returning focus to the header trigger button.
- Reduced motion: `@media (prefers-reduced-motion: reduce)` zeroes transitions and animations across all components.

## What was explicitly not done

In strict accordance with the constraints for this tranche:
- **Borrow Screens & Adapters (Trap 2)**: The borrow screen (`borrowScreen.tsx`) and borrow adapters remain untouched in this tranche.
- **Unverified Backends**: Routes lacking backend completion (`Deposit BTC`, `Liquidity`, `Staking`) fail closed with `UnsupportedStateView`.

## Verification evidence

### 1. Monorepo CI (`pnpm run ci`)
- **TypeScript Typecheck**: All 24 workspace packages passed with 0 errors.
- **Dependency Cruiser Boundaries**: 220 modules and 737 dependencies cruised with 0 violations (excluding test reports).
- **Biome Linter**: Clean (0 errors, 0 warnings across 248 files).
- **Unit Tests**:
  - `@stacks-capital/ui`: 112 passed, 0 failed (testing `attemptTxid`, `contractOf`, `excludedFrom`, `workflowAnnouncement`, `explorerTxUrl`, and `canSign`).
  - `@stacks-capital/web`: 7 passed, 0 failed (including stylesheet token contrast mathematical checks).
- **Production Builds**: `api`, `web`, and `docs` built successfully.
- **Schema Contracts**: `openapi.json` and `api-errors.md` confirmed up to date.

### 2. Browser Tests (`pnpm test:browser`)
- **23 passed, 3 skipped (mobile skips for desktop-only checks)** across Chromium desktop and mobile viewports.
- **Axe WCAG 2.1 AA audits**: 0 serious or critical accessibility violations across all 10 tabs, both signed in and signed out.
- **Keyboard navigation**: Entire application drivable via keyboard alone.
- **Workflow drawer**: Focus entry, Tab trapping, Escape dismissal, and trigger focus return verified in Playwright.
- **Canonical states**: Render of Empty, Unsupported, Review, Stale, and Submitted states verified in the browser.
- **Mobile reflow**: Verified zero horizontal scrolling on mobile viewports.
- **Wallet journeys**: Sign in, signature rejection, reload mid-signing, wallet isolation, and session disconnect verified.
