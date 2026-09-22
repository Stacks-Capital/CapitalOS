# Engineering Design & Verification: React SDK Hooks and Embedded Workflow Components (I30)

## 1. Overview & Objectives

- **Task**: I30: Publish React SDK hooks and embedded workflow components
- **Track**: Partner SDK
- **Priority**: P1
- **Dependencies**: I29, K35
- **Deliverables**:
  1. Provide wallet, portfolio, market, quote, and workflow hooks in `@stacks-capital/react`.
  2. Provide optional review, progress, recovery, and receipt components in `@stacks-capital/ui`.
- **Acceptance Evidence**:
  1. *Cache keys isolate tenant, network and address* (verified via `scopeKey`, `cacheKey`, `sameScope`, `CapitalProvider`, and hook tests).
  2. *Workflow state resumes after reload* (verified via `pendingKey`, `loadPending`, `savePending`, and `useWorkflowResume`).
  3. *Everything Stacks consumes the same public package exports as partners* (verified via `apps/web` and `apps/embed-example` consuming public packages only).

---

## 2. Architecture & Design

```
+-----------------------------------------------------------------------------------+
|                                Partner Application                                |
|          (or Stacks Web Application: apps/web, apps/embed-example)               |
+-----------------------------------------+-----------------------------------------+
                                          |
                   +----------------------+----------------------+
                   |                                             |
                   v                                             v
+--------------------------------------+      +-------------------------------------+
|        @stacks-capital/react         |      |         @stacks-capital/ui          |
|  - CapitalProvider                   |      |  - Widgets:                         |
|  - useCapital                        |      |    EarnComparison, PositionsSummary,|
|  - useCapitalQuery                   |      |    QuoteSummary, WorkflowHistory    |
|  - useMarkets, useCapabilities       |      |  - Shell & Progress:                |
|  - useEarnOptions, usePrices         |      |    WorkflowDrawer, WorkflowAnnouncer|
|  - useMarketRisk, usePositions       |      |  - States (Canonical 8):            |
|  - usePortfolio                      |      |    ReviewStateView, StateView,      |
|  - useEarnPerformance                |      |    LoadingStateView, PartialState...|
|  - usePriceValuations                |      |  - Recovery:                        |
|  - useWorkflow, useWorkflows         |      |    loadPending, savePending,        |
|  - useWorkflowResume                 |      |    clearPending, pendingKey         |
+------------------+-------------------+      +------------------+------------------+
                   |                                             |
                   +----------------------+----------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                               @stacks-capital/client                              |
|  - Scoped Cache: scopeKey(tenantId, network, address)                             |
|  - Cache Invalidation & Subscriptions (useSyncExternalStore)                      |
|  - HTTP Transport to /v1/* endpoints with telemetry and typed financial errors    |
+-----------------------------------------------------------------------------------+
```

### 2.1 Cache Scoping & Isolation

Cache keys enforce strict tenant, network, and address isolation. Cross-tenant leakage, cross-network pollution (mainnet vs testnet), and cross-wallet data retention are strictly prevented.

- **`Scope`**:
  ```ts
  export type Scope = {
    network: StacksNetwork;
    address: string | null;
    tenantId?: string | null;
  };
  ```
- **`scopeKey(scope)`**:
  ```ts
  const tenantPrefix = scope.tenantId ? `${scope.tenantId}|` : "";
  return `${tenantPrefix}${scope.network}|${scope.address ?? "anonymous"}`;
  ```
- **`cacheKey(scope, resource, params)`**:
  Deterministically formats resource queries, sorting query parameters alphabetically to guarantee canonical cache indexing:
  ```ts
  `${scopeKey(scope)}|${resource}?${sortedParams}`
  ```
- **`sameScope(left, right)`**:
  Compares `network`, `address`, and `tenantId` (normalizing `undefined` to `null`).

In React components:
- `CapitalProvider` accepts `tenantId?: string | null`. If not explicitly supplied, it derives `tenantId` from `client.clientId`.
- When wallet address or tenant changes, `CapitalProvider` updates the active scope. Hook subscribers (`useSyncExternalStore`) immediately reconcile against the new cache entries and drop prior unshared state.

---

## 3. React SDK Hooks Reference (`@stacks-capital/react`)

All hooks utilize `useCapitalQuery` internally, combining React 19's `useSyncExternalStore` with background stale-while-revalidate caching and refresh handling:

| Hook | Return Type | Cache Resource | Description |
|---|---|---|---|
| `useMarkets(options?: PageQuery)` | `QueryResult<Page<Market>>` | `markets` | Lists available money markets with pagination. |
| `useCapabilities(options?: PageQuery)` | `QueryResult<Page<MarketCapability>>` | `capabilities` | Queries supported protocol capabilities per market. |
| `useEarnOptions(options?: QueryOptions)` | `QueryResult<Result<{ items: EarnOption[] }>>` | `earnOptions` | Observed APYs, contract addresses, and risk parameters. |
| `usePrices(options?: QueryOptions)` | `QueryResult<Result<{ items: OracleQuoteView[] }>>` | `prices` | Monitored oracle prices with publisher timestamps. |
| `usePriceValuations(options?: QueryOptions)` | `QueryResult<Result<{ items: AssetValuation[] }>>` | `priceValuations` | Multi-source price quorum valuations and spreads. |
| `useMarketRisk(marketId, options?: QueryOptions)` | `QueryResult<Result<MarketRisk>>` | `risk` | Liquidation thresholds, collateral factors, and user health. |
| `usePositions(options?: QueryOptions & { owner?: string })` | `QueryResult<Result<{ items: Position[] }>>` | `positions` | Verified collateral and debt balances. |
| `usePortfolio(options?: QueryOptions & { owner?: string })` | `QueryResult<Result<PortfolioAccountingView>>` | `portfolio` | Canonical portfolio accounting segregated by capital category. |
| `useEarnPerformance(options?: QueryOptions & { owner?: string; marketId?: string })` | `QueryResult<Result<{ items: EarnPerformanceItemView[] }>>` | `earnPerformance` | 3-tier earnings separation (realized, claimed, accrued). |
| `useWorkflows(options?: PageQuery)` | `QueryResult<Page<WorkflowSummary>>` | `workflows` | Paginated workflow summaries for the connected user. |
| `useWorkflow(id: string \| null, options?: QueryOptions)` | `QueryResult<Result<Workflow>>` | `workflow` | Complete workflow execution record and transitions. |
| `useWorkflowResume(id: string \| null, options?: QueryOptions)` | `WorkflowResumeResult` | `workflow` | Computes `ResumeHint`, `isResuming`, `canSign`, `isTerminal`. |

### 3.1 `useWorkflowResume` Hook

Designed specifically for workflow continuity across browser reloads:
```ts
export type WorkflowResumeResult = {
  workflow: QueryResult<Result<Workflow>>;
  hint: ResumeHint | null;
  isResuming: boolean;
  canSign: boolean;
  isTerminal: boolean;
  refresh: () => Promise<void>;
};
```
- Calls `useWorkflow(id)`.
- Invokes `@stacks-capital/core`'s pure `resumeHint(workflow)`.
- Returns actionable flags:
  - `isResuming: true` when workflow state is resumable (`DRAFT`, `QUOTED`, `AWAITING_SIGNATURE`, `CONFIRMING`, `RECONCILING`, `BROADCAST_UNKNOWN`, etc.).
  - `canSign: true` when ready for wallet signature (`AWAITING_SIGNATURE`).
  - `isTerminal: true` when workflow reaches final completion or terminal cancellation.

---

## 4. UI Embedded Workflow Components Reference (`@stacks-capital/ui`)

`@stacks-capital/ui` provides drop-in components adhering to CapitalOS design tokens:

### 4.1 Review Components
- `ReviewStateView`: Renders pre-execution review panels with parameter verification, asset impacts, and fee summaries.
- `QuoteSummary`: Displays quote input, expected output, minimum output, and fees.
- `reviewQuote(quote, now)`: Pure helper computing countdown timer, expiry status, and executability.

### 4.2 Progress Components
- `WorkflowDrawer`: Responsive overlay showing real-time step progress, confirmed transactions, and explorer links.
- `WorkflowAnnouncer`: Accessible screen reader live region announcing step progression.
- `LoadingStateView`: Informative loader with elapsed duration and cancellation prompts.
- `SubmittedStateView`: Displays broadcast confirmation, transaction IDs, and block heights.

### 4.3 Recovery Components
- `FailedDelayedStateView`: Guides users through transaction delays, slippage failures, and requote steps.
- `StaleDisputedStateView`: Flags oracle quorum disagreements or stale price feeds.
- `StateView`: Polymorphic renderer handling all 8 canonical states.
- `loadPending(storage, scope)` / `savePending(storage, scope, pending)` / `clearPending(storage, scope)`: Scoped browser storage persistence with tenant isolation.

### 4.4 Receipt Components
- `PositionsSummary`: Displays verified protocol holdings and debt balances.
- `EarnComparison`: Compares verified yields and protocol capabilities.
- `WorkflowHistory`: Lists historical workflow audit trails with transaction links.

---

## 5. Verification & Acceptance Evidence

1. **Cache Key Isolation**:
   - `scopeKey` and `cacheKey` verified with tenant prefixes (`tenant_a|mainnet|SP1` vs `tenant_b|mainnet|SP1`).
   - `sameScope` tests confirm exact scoping.
   - React hook harness tests confirm separate cache entries for distinct tenants and addresses.
2. **Workflow Resumption After Reload**:
   - `pendingKey(scope)` verifies storage key isolation.
   - `savePending` and `loadPending` tested across browser storage failure modes and invalid payloads.
   - `useWorkflowResume` verified with active, completed, and idle workflows.
3. **Public Package Surface & Parity**:
   - `PUBLIC_VALUE_EXPORTS["@stacks-capital/react"]` updated and validated in `packages/sdk/src/surface.test.ts`.
   - `apps/web` and `apps/embed-example` consume public packages only (`@stacks-capital/client`, `@stacks-capital/react`, `@stacks-capital/ui`, `@stacks-capital/core`, `@stacks-capital/sdk`, `@stacks-capital/wallets`).
   - Architecture boundary check (`pnpm boundaries`) confirms zero cross-boundary violations.
