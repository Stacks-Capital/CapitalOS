# Engineering Design & Verification: External Partner Example and Integration Documentation (I39)

## 1. Overview & Objectives

- **Task**: I39: Deliver external partner example and integration documentation
- **Track**: Partner SDK
- **Priority**: P0
- **Goal**: Provide a clean external partner application (`apps/partner-example`) consuming public packages only (`@stacks-capital/sdk`, `@stacks-capital/client`, `@stacks-capital/react`, `@stacks-capital/ui`), complete with sandbox entry (`supply`) and exit (`withdraw_supply`), isolated revocable test credentials, and comprehensive integration documentation.

---

## 2. Architecture & Design

### 2.1 Public Package Boundary Separation
The external partner application demonstrates integration strictly using public packages:
- `@stacks-capital/sdk`: Validates plans, wraps workflow state machines, checks wallet compatibility.
- `@stacks-capital/client`: HTTP queries to Capital API.
- `@stacks-capital/react` & `@stacks-capital/ui`: Embeddable hooks and widgets.
- `@stacks-capital/core` & `@stacks-capital/wallets`: Re-exported shared types.

Internal packages (`@stacks-capital/engine`, `@stacks-capital/fixtures`, `@stacks-capital/adapters`, `@stacks-capital/database`) are strictly prohibited in partner-facing code. Boundary rules in `.dependency-cruiser.cjs` and release gate K39 prevent internal leaks.

### 2.2 Entry and Exit Lifecycle in Sandbox
- **Entry (`runZestSupply`)**:
  - Posts intent `{ action: "supply", marketId: "zest.sbtc.vault", amount: "100000000" }` to `/v1/quotes`.
  - Validates quote and plan via `os.validate(parsePlan(plan), parseQuote(quote), { sender })`.
  - Advances durable workflow to `AWAITING_SIGNATURE`.
  - Enforces invariant: `os.submit()` throws `UNSUPPORTED_ACTION`.
- **Exit (`runZestWithdrawSupply` / `runZestExit`)**:
  - Posts intent `{ action: "withdraw_supply", marketId: "zest.sbtc.vault", amount: "50000000" }` to `/v1/quotes`.
  - Validates exit plan against active registry (`v0-vault-sbtc` `redeem`).
  - Advances durable workflow to `AWAITING_SIGNATURE`.
  - Returns calculated underlying output assets and receipt deltas.

### 2.3 Disposable Credentials & Test Isolation
- Isolated test account in `apps/partner-example/src/disposable-test-account.ts`.
- Standard sandbox owner fallback: `SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR`.
- Local revocation functions: `revokeDisposableCredentials()`, `resetDisposableCredentials()`, `isCredentialRevoked()`.
- Guarantees credentials are never funded and never broadcast on-chain.

---

## 3. Acceptance Verification

| Acceptance Evidence | Implementation & Verification Method | Status |
|---|---|---|
| **Evidence 1: Sandbox Entry & Exit without Internal Imports** | `apps/partner-example/src/program.ts` implements `runZestSupply` and `runZestWithdrawSupply` importing only from `@stacks-capital/sdk`. Verified via `pnpm partner:example` and `pnpm --filter @stacks-capital/partner-example test`. | **PASSED** |
| **Evidence 2: Disposable Test Credentials Isolated & Revocable** | `apps/partner-example/src/disposable-test-account.ts` provides revocable credential handling and fallback sandbox principal. Verified with unit tests testing revocation guards. | **PASSED** |
| **Evidence 3: Compatibility Matrix & Migration Guide** | `docs/guides/sdk-migration-0.1.md` and `docs/guides/partner-integration.md` publish the full compatibility matrix, install instructions, auth scopes, wallet integration, webhooks, and recovery. Verified via `pnpm gate:k39`. | **PASSED** |

---

## 4. Verification Commands

```bash
# Partner example execution
pnpm partner:example

# Partner example unit tests
pnpm --filter @stacks-capital/partner-example test

# Boundary checks
pnpm boundaries

# Typecheck across 25 projects
pnpm typecheck

# Biome lint
pnpm lint

# K39 gate check
pnpm gate:k39
```
