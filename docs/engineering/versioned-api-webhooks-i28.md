# Engineering Design & Verification: Versioned API, Authentication, and Webhook Surface (I28)

## 1. Overview & Objectives

- **Task**: I28: Finalize versioned API, authentication and webhook surface
- **Track**: Partner SDK
- **Priority**: P0
- **Dependencies**: I22, K22, K35
- **Goal**: Serve capabilities, markets, positions, quotes, plans, workflows, and webhook endpoints under `/v1/*`, enforce tenant scopes, sessions, idempotency, and signed webhooks with retry and deduplication.

---

## 2. Architecture & Design

```
                     +----------------------------------+
                     |         Partner Client           |
                     +-----------------+----------------+
                                       |
                   Authorization: Bearer key_<id>.<secret>
                   x-capital-client-id (Browser / Session)
                                       |
                                       v
                     +----------------------------------+
                     |         /v1 API Gateway          |
                     |  (CORS, Auth, Scopes, Ratelimit) |
                     +-----------------+----------------+
                                       |
      +-----------------+--------------+-----------------+-----------------+
      |                 |                                |                 |
      v                 v                                v                 v
+-----------+    +---------------+               +---------------+   +------------+
|  Markets  |    | Quotes & Plans|               |   Workflows   |   |  Webhooks  |
| /v1/*read |    | /v1/*write    |               | /v1/*write    |   | /v1/*manage|
+-----------+    +---------------+               +---------------+   +-----+------+
                                                                           |
                                                                           v
                                                         +-----------------------------+
                                                         |     Webhook Delivery Engine |
                                                         |  - HMAC-SHA256 (t=...,v1=..) |
                                                         |  - DB Unique Deduplication  |
                                                         |  - Exponential Backoff Retry|
                                                         +-----------------------------+
```

### 2.1 Versioned Route Topology & Tenant Scoping
All operational endpoints are strictly versioned under `/v1/*`:
- `/v1/capabilities`: Market capabilities (`markets:read`)
- `/v1/markets`: Market registry and configurations (`markets:read`)
- `/v1/markets/{id}/risk`: Protocol risk parameters, oracles, positions (`markets:read`)
- `/v1/markets/{id}/evidence`: Oracle evidence, telemetry age, disagreement (`markets:read`)
- `/v1/prices` & `/v1/prices/valuations`: Price feeds and quorum valuations (`markets:read`)
- `/v1/positions` & `/v1/portfolio`: Address balances, net debt, and category accounting (`positions:read`)
- `/v1/earn/options` & `/v1/earn/performance`: Earn listings, yield attribution, projections (`markets:read`)
- `/v1/quotes` & `/v1/plans`: Quoting and deterministic execution plan generation (`quotes:write`)
- `/v1/workflows` & `/v1/workflows/{id}`: Execution state machine tracking and signing (`workflows:write`)
- `/v1/webhooks/endpoints`: Tenant webhook subscription management (`webhooks:manage`)

Tenant scopes are enforced through the `api_scope` domain:
- `markets:read`
- `positions:read`
- `quotes:write`
- `workflows:write`
- `webhooks:manage`

API keys are checked against their required scopes. Calling webhook management endpoints without `webhooks:manage` immediately halts with a typed `403 FORBIDDEN` error.

### 2.2 Actionable Problem Responses (Evidence 2)
All non-2xx responses strictly conform to the `ErrorBody` contract:
```json
{
  "schemaVersion": "1.0",
  "requestId": "req_0123456789abcdef",
  "error": {
    "code": "FORBIDDEN",
    "message": "API key is missing the webhooks:manage scope",
    "action": "Use a caller with the right scope. Never send an API key from a browser."
  }
}
```
Every `ApiErrorCode` maps deterministically to an explicit remediation instruction in `ACTIONABLE_REMEDIATIONS` (`apps/api/src/errors.ts`), eliminating ambiguity for partner developers. Verified via `pnpm docs:errors:check`.

### 2.3 Signed Webhook Engine (Evidence 3)

#### HMAC-SHA256 Signing & Verification
- **Header format**: `x-capital-signature: t=<timestamp>,v1=<signature>`
- **Payload canonicalization**: `${timestamp}.${rawPayload}`
- **Signing key**: Secret `whsec_<48-hex>` generated once upon endpoint registration and hashed with SHA-256 before persistence.
- **Constant-time comparison**: Evaluated via `crypto.timingSafeEqual` to eliminate timing attacks.
- **Replay attack mitigation**: Validates that `|now - timestamp| <= toleranceSeconds` (default: 300 seconds).

#### Database-Enforced Deduplication
- Deliveries are logged in table `webhook_deliveries` with constraint `UNIQUE (endpoint_id, event_id)`.
- Re-publishing an already delivered or scheduled `(endpoint_id, event_id)` pair performs `ON CONFLICT DO NOTHING` and returns `{ isDuplicate: true, deliveryId }`.

#### Exponential Backoff Retry Scheduling
- On failure, attempt count increments.
- Backoff delay: `2^attempts` seconds (attempt 1: 2s, attempt 2: 4s, attempt 3: 8s, up to 1 hour max).
- If `attempts >= max_attempts`, delivery status transitions to `'abandoned'` and `next_retry_at` is set to `null`.

---

## 3. Acceptance Evidence

| Acceptance Requirement | Verification Method | Status |
| :--- | :--- | :--- |
| **Evidence 1: Runtime schemas & OpenAPI agree** | `pnpm openapi:check` passes with zero drift. OpenAPI 3.1.0 document defines all `/v1/*` routes including webhooks. | **PASSED** |
| **Evidence 2: Problem responses are typed & actionable** | `pnpm docs:errors:check` verifies documentation sync. Integration tests verify `401`, `403`, `400` errors include actionable `action` strings. | **PASSED** |
| **Evidence 3: Webhook retry & deduplication demonstrated** | Comprehensive integration test (`versioned-api-webhooks.test.ts`) verifies HMAC signing, tolerance checks, DB deduplication, and exponential backoff retry up to abandonment. | **PASSED** |

---

## 4. Verification Commands
```bash
# Architecture and boundaries
pnpm boundaries

# Typecheck all 24 packages
pnpm typecheck

# Unit tests
pnpm test:unit

# Database migrations
pnpm db:migrate

# OpenAPI and documentation checks
pnpm openapi:check
pnpm docs:errors:check

# Integration tests
node --experimental-strip-types --env-file-if-exists=.env.local --test apps/api/test/integration/versioned-api-webhooks.test.ts

# Release gates
pnpm gate:k38 && pnpm gate:k39 && pnpm gate:k40
```
