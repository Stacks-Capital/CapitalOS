# Engineering Design & Verification: Browser SDK Client and Typed Financial Errors (I29)

## 1. Overview & Objectives

- **Task**: I29: Publish browser SDK client and typed financial errors
- **Track**: Partner SDK
- **Priority**: P0
- **Dependencies**: I28, K34
- **Deliverables**:
  1. Expose public read, quote, plan, workflow, and validation clients.
  2. Ship typed errors and safe bigint/fixed-point serialization.
- **Acceptance Evidence**:
  1. *SDK has no dependency on internal adapters or web application code* (verified via `pnpm boundaries`).
  2. *A clean consumer compiles in browser and server environments* (verified via `consumer.test.ts` and `apps/partner-example`).
  3. *All public methods document evidence and failure semantics* (verified via TSDoc on `Stacks Capital` and `CapitalClient`).

---

## 2. Architecture & Design

```
+-----------------------------------------------------------------------------+
|                             Partner Application                             |
|  (Browser / Wallet / Embed / Server / Node 22+ / Pure ESM / Zero Node Builtins)  |
+------------------------------------+----------------------------------------+
                                     |
             +-----------------------+-----------------------+
             | imports from @stacks-capital/sdk              |
             v                                               v
+-----------------------------+               +-------------------------------+
|        CapitalClient        |               |           Stacks Capital           |
| (HTTP Read, Quote, Workflow)|               | (Local Validation & Workflow) |
+--------------+--------------+               +---------------+---------------+
               |                                              |
               v                                              v
+-----------------------------+               +-------------------------------+
|     /v1 Remote Gateway      |               |     Local Signing Boundary    |
| - Markets, Prices, Valuations|              | - validate(plan, quote)       |
| - Accounting, Performance   |               | - assertReadyToSign()         |
| - Quotes & Workflows        |               | - state machine progression   |
| - Context & Evidence audit  |               | - wallet error classification |
+-----------------------------+               +-------------------------------+
```

### 2.1 Dual Client Topology

1. **`CapitalClient` (`@stacks-capital/client`, re-exported by `@stacks-capital/sdk`)**:
   - Manages HTTP transport to `/v1/*` endpoints.
   - Returns structured data envelopes paired with verified telemetry context (`requestId`, `network`, `observedAt`, `blockHeight`, `blockHash`, `stale`, and `warnings`).
   - Enforces browser security: prevents `apiKey` usage in browsers (throws `CapitalConfigError`), requiring `clientId` and wallet `sessionToken` instead.
   - Automatically retries transient reads with exponential backoff and server `Retry-After` honoring, while never automatically retrying single-attempt writes.

2. **`Stacks Capital` (`@stacks-capital/sdk`)**:
   - Executes purely offline/in-memory without backend or Node dependencies.
   - Evaluates plan structure, quote binding, expiry, and registered contract principals (`validate`, `assertReadyToSign`).
   - Drives the non-custodial workflow state machine (`CREATED`/`DRAFT` → `QUOTED` → `AWAITING_SIGNATURE` → `SUBMITTED` → `CONFIRMING` → `RECONCILING` → `COMPLETED`).
   - Classifies wallet-specific responses (Leather, Xverse) into deterministic `WalletOutcome` and canonical `ErrorCode`.
   - Never broadcasts transactions directly (`submit()` strictly throws `UNSUPPORTED_ACTION`).

---

## 3. Typed Financial Errors

Financial workflows require actionable, programmatic error recovery. Raw HTTP status codes are insufficient to distinguish between a stale oracle that warrants requoting versus an ambiguous broadcast requiring manual investigation.

### 3.1 Class Hierarchy & Categorization

```
                          Error
                            |
                     CapitalApiError
                     (code, errorClass, status, requestId, retryAfter, action)
                            |
                 CapitalFinancialError
                 (isRequote(), isUserAction(), isInvestigation(), isRetryableRead())
```

- **Requote Errors (`isRequote()`)**: `QUOTE_EXPIRED`, `CAP_REACHED`, `ORACLE_STALE`, `QUORUM_DISAGREEMENT`.
  - *Action*: The consumer should fetch a fresh quote from `/v1/quotes` before retrying.
- **User Action Errors (`isUserAction()`)**: `USER_REJECTED`, `INSUFFICIENT_BALANCE`, `NETWORK_MISMATCH`, `UNSUPPORTED_WALLET`, `UNSUPPORTED_ACTION`, `PLAN_INVALID`, `CAPABILITY_DISABLED`.
  - *Action*: Inform the user (e.g., prompt to switch networks, deposit assets, or review wallet status).
- **Investigation Errors (`isInvestigation()`)**: `BROADCAST_UNKNOWN`, `REORG_DETECTED`, `RECONCILIATION_MISMATCH`, `UNCLASSIFIED`.
  - *Action*: Must **never** be blindly retried with a duplicate write. Flag for background reconciliation or support review.
- **Retryable Read Errors (`isRetryableRead()`)**: `PROVIDER_TIMEOUT`, `RATE_LIMITED`, `TEMPORARY_UNAVAILABLE`.
  - *Action*: Safe to retry automatically with backoff.

### 3.2 Interoperable Error Predicates

Both core `CapitalError` objects and client/SDK `CapitalFinancialError` instances are supported by canonical type guards:
- `isCapitalError(error: unknown): error is CapitalError`
- `isFinancialError(error: unknown): error is CapitalError`
- `isCapitalApiError(error: unknown): error is CapitalApiError`
- `isCapitalFinancialError(error: unknown): error is CapitalFinancialError`
- `isRequoteError(error: CapitalError | CapitalApiError): boolean`
- `isUserActionError(error: CapitalError | CapitalApiError): boolean`
- `isInvestigationError(error: CapitalError | CapitalApiError): boolean`
- `allowsWriteRetry(error: CapitalError | CapitalApiError): boolean`

---

## 4. Safe BigInt and Fixed-Point Serialization

JavaScript floating-point numbers (`number`) suffer from precision loss when representing financial quantities. The SDK enforces string and BigInt representations across all boundaries.

### 4.1 Fixed-Point Conversion

- **`parseUnits(value: string, decimals: number | bigint): bigint`**:
  - Parses human-entered decimal strings into exact bigint integer quantities.
  - Rejects scientific notation (`1e6`), trailing dots (`.`), multiple dots (`1.2.3`), and precision exceeding the asset's declared decimals.
  - Examples:
    - `parseUnits("1.5", 6)` → `1500000n` (USDCx)
    - `parseUnits("1.00000001", 8)` → `100000001n` (sBTC)
    - `parseUnits("1.0", 18)` → `1000000000000000000n` (Clarity uint / EVM)

- **`formatUnits(quantity: bigint | string, decimals: number | bigint, options?: FormatUnitsOptions): string`**:
  - Formats bigint units into human-readable fixed-point strings.
  - Supports `maxDecimals` and `trimTrailingZeros`.
  - Examples:
    - `formatUnits(1500000n, 6)` → `"1.500000"`
    - `formatUnits(1500000n, 6, { trimTrailingZeros: true })` → `"1.5"`
    - `formatUnits(100000001n, 8, { maxDecimals: 4, trimTrailingZeros: true })` → `"1"`

### 4.2 Safe BigInt JSON Serialization

Native `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` when encountering bigints:
- **`safeBigIntReplacer(key: string, value: unknown): unknown`**: Serializes bigints as decimal strings.
- **`serializeFinancialJson(value: unknown, space?: number | string): string`**: Serializes complex data structures without runtime errors.
- **`parseFinancialJson<T>(json: string): T`**: Deserializes JSON payloads.

---

## 5. Verification & Acceptance Evidence

### 5.1 Verification Commands Run & Passing

```bash
# 1. Architecture Boundaries Check
pnpm boundaries
# Result: Architecture boundaries passed. No dependency violations found.

# 2. Package Compatibility & Export Validation
pnpm sdk:compat
# Result: 27/27 checks passed. Surface holds at 0.1.0; production no-go; sandbox Zest supply only.

# 3. SDK Functional Check
pnpm sdk:check
# Result: 10/10 checks passed. Engine quotes; SDK validates. Unsigned plans only.

# 4. Partner Example Application
pnpm partner:example
# Result: Quotes, validates, and stops at AWAITING_SIGNATURE cleanly.

# 5. Automated Consumer Tests
pnpm --filter @stacks-capital/sdk test
# Result: 21/21 tests passed, including browser/server compatibility and serialization suites.

# 6. Core Numeric & Error Tests
pnpm --filter @stacks-capital/core test
# Result: 88/88 tests passed.

# 7. Client HTTP & Error Tests
pnpm --filter @stacks-capital/client test
# Result: 37/37 tests passed.

# 8. Release Gate Certifications
pnpm gate:k38 && pnpm gate:k39 && pnpm gate:k40
# Result: K38 (11/11), K39 (23/23), K40 (18/18) all passed.
```

### 5.2 Acceptance Evidence Summary

1. **Zero internal dependencies**:
   - `packages/sdk` and `packages/client` import only `@stacks-capital/core`, `@stacks-capital/config`, and `@stacks-capital/wallets`.
   - Strictly forbidden from importing `adapters`, `engine`, `database`, or `fixtures` in production source code.
2. **Clean consumer compiles and executes in browser and server**:
   - Proven via `packages/sdk/src/consumer.test.ts` and `apps/partner-example`.
   - Browser client prevents credential exposure. Server client enables service key authentication.
3. **Evidence and failure semantics documented**:
   - Complete TSDoc annotations on `CapitalClient` and `Stacks Capital` describing returned telemetry, failure exceptions (`@throws`), and retry policies.
