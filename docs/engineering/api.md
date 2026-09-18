# API

| | |
|---|---|
| Task | I05 API skeleton and tenant access |
| Requirements | SDK-01, SEC-01 |
| Owner / reviewer | IBK / kenzman |
| Date | 2026-09-17 |

Deliverable from the task page: implement versioned API schemas, pagination, rate limits and session and key boundaries; reject cross tenant workflow reads.

This task lands in two parts. Part one is the skeleton: routing, schemas, envelope, errors, pagination and OpenAPI. Part two is tenant access: publishable client ids with allowed origins, API keys, wallet sign in sessions, rate limits and tenant checks on workflow reads.

## Stack

| Piece | Version |
|---|---|
| Hono | 4.13.8 |
| `@hono/zod-openapi` | 1.6.3 |
| zod | 4.6.5 |
| `@hono/node-server` | 2.1.1 |
| `@stacks/encryption`, `@stacks/transactions` | 7.6.0 (wallet signature checks) |
| `redis` | 6.2.1 (rate limit counters) |

Routes declare zod schemas. The same schemas validate requests and generate the OpenAPI document (page 01).

## Commands

| Command | What it does |
|---|---|
| `pnpm api:dev` | Starts the API on `127.0.0.1`, port `API_PORT` (default 3000). Needs `DATABASE_URL` and `REDIS_URL`, and exits if Redis cannot be reached within 5 seconds |
| `pnpm openapi:write` | Regenerates `apps/api/openapi.json` from the route schemas |
| `pnpm openapi:check` | Fails when `apps/api/openapi.json` does not match the route schemas. Runs in CI |

## Conventions

- **Versioning.** Every route lives under `/v1`.
- **Network.** Every request must pass `network=mainnet` or `network=testnet`. There is no default network (page 01).
- **Envelope.** Successful responses carry `schemaVersion`, `requestId`, `network` (`stacks:mainnet` or `stacks:testnet`), `data` and `context` (`observedAt`, `stale`, `warnings`, and `blockHeight` and `blockHash` when data comes from a block). The request id is also returned in the `x-request-id` header.
- **Errors.** Error responses carry `schemaVersion`, `requestId` and `error` (`code`, `message`, optional `retryAfter`). Codes are core's error contract plus transport codes:

  | Code | Status |
  |---|---|
  | `INVALID_REQUEST`, `NETWORK_MISMATCH` | 400 |
  | `UNAUTHORIZED` | 401 |
  | `FORBIDDEN` | 403 |
  | `NOT_FOUND` | 404 |
  | `RATE_LIMITED` | 429 |
  | `PROVIDER_TIMEOUT`, `TEMPORARY_UNAVAILABLE` | 503 |
  | `INTERNAL` and anything unexpected | 500 |

  Unexpected failures return `INTERNAL` with a generic message and never expose internal details.
- **Pagination.** List routes take `limit` (1 to 100, default 20) and `cursor`. Cursors are opaque, name the list they belong to and hold the last key. Queries use keyset pagination on stable keys, and `nextCursor` is `null` on the last page. A tampered cursor or a cursor from another list is rejected.

## Routes

| Route | Callers | Returns |
|---|---|---|
| `GET /v1/markets` | Any caller. Keys need `markets:read` | Markets for a network with their per action capabilities, ordered by market id |
| `GET /v1/capabilities` | Any caller. Keys need `markets:read` | Capabilities for a network, ordered by market and action |
| `POST /v1/auth/challenge` | Browser app | A sign in message for a Stacks address on the requested network |
| `POST /v1/auth/verify` | Browser app | A wallet session token for a signed challenge |
| `GET /v1/workflows/{id}` | Key with `workflows:write`, or wallet session | One workflow with its state transitions |
| `GET /v1/openapi.json` | Anyone | The OpenAPI 3.1 document, including the three security schemes |

Registry reads come from `@stacks-capital/database`, whose query helpers the worker can reuse.

## Tenant access

### Callers

| Caller | Sent as | Where it is used | Boundary |
|---|---|---|---|
| Browser app | `x-capital-client-id: pk_...` plus the browser's `Origin` | Partner frontends | The client id is public. It is accepted only from an origin listed for that app, and it can read the registry and start a wallet sign in, nothing more |
| API key | `Authorization: Bearer key_<id>.<secret>` | Partner servers | Scoped (`markets:read`, `positions:read`, `quotes:write`, `workflows:write`, `webhooks:manage`). A request that carries a key and an `Origin` header is refused with `FORBIDDEN`, so a key leaked into browser code stops working there |
| Wallet session | `Authorization: Bearer ses_<id>.<secret>` | Partner frontends after sign in | Bound to one app, one address and one network, valid for 1 hour |

Secrets are 32 random bytes. Only their SHA256 hashes are stored and compared in constant time. Tokens are returned once. Missing, unknown, revoked or expired credentials give `UNAUTHORIZED`; valid credentials without the right scope or caller type give `FORBIDDEN`.

### Wallet sign in

1. The app calls `POST /v1/auth/challenge` with `network` and `address`. An address from the other network gives `NETWORK_MISMATCH`. The API stores a nonce for the app and origin, valid for 5 minutes, and returns the message:

   ```text
   Capital OS wants you to sign in with your Stacks account:
   <address>

   Origin: <origin>
   Network: <network>
   Nonce: non_<32 hex>
   Issued At: <ISO time>
   Expiration Time: <ISO time>
   ```

2. The wallet signs that exact text (`stx_signMessage`).
3. The app calls `POST /v1/auth/verify` with `network`, `nonceId`, `publicKey` and `signature`. The session is issued only when the nonce belongs to the calling app, was issued to the same origin and network, has not expired, the public key derives the address in the message and the signature verifies. The response has `cache-control: no-store`.

A nonce is marked used before the signature is checked, so each challenge gets exactly one attempt. Every failure returns the same `UNAUTHORIZED` message, so a caller cannot tell which check failed. The signature check is tested with a real Leather signature recorded in I02.

### Workflow reads

The tenant filter is part of the query: a key sees workflows of its own app, and a session sees workflows of its app owned by its address. A workflow of another tenant gives the same `404 NOT_FOUND` body as an id that does not exist. A session or workflow on a different network than the request gives `NETWORK_MISMATCH`. Browser apps without a session get `FORBIDDEN`.

### CORS

Preflight and responses allow an origin only when an enabled app lists it. Allowed methods are `GET` and `POST`, allowed request headers are `authorization`, `content-type` and `x-capital-client-id`, and the request id and rate limit headers are exposed to browser code.

### Rate limits

| Caller | Bucket | Default per 60 seconds |
|---|---|---|
| API key | Key id | 600 |
| Wallet session | Session id | 120 |
| Browser app | App id and client IP | 60 |

Counters live in Redis in fixed 60 second windows (`INCR` plus `EXPIRE NX`), so every API instance shares them. Each response carries `ratelimit-limit`, `ratelimit-remaining` and `ratelimit-reset`. Over the limit the API answers `429 RATE_LIMITED` with `retry-after` and `retryAfter` in the body.

Rate limits fail closed. Commands are not queued while Redis is disconnected, and a command that takes longer than 1 second is abandoned; either way the API answers `503 TEMPORARY_UNAVAILABLE` rather than serving without limits.

## Tests

- Unit (`apps/api/src/*.test.ts`), with a database stub that fails if it is reached: missing or unknown network, page size limits, tampered and foreign cursors, credentials required and checked only after validation, unknown routes, unexpected errors hidden behind `INTERNAL`, cursor round trip, the served OpenAPI document, signature checks (generated keys and the I02 Leather vector; wrong origin, address, network, message, key and signature), the memory limiter window, and the Redis limiter failing closed when disconnected or not answering.
- Integration (`apps/api/test/integration`), against a migrated and seeded schema and the Compose Redis:
  - Registry: mainnet markets in the envelope, paging with no gaps or repeats, testnet actions disabled, capability paging that matches the database.
  - Tenant access: client id from allowed and other origins, unknown client id, CORS preflight, keys refused from browsers and without scope, a full wallet sign in with a generated key, one use per challenge, a burned challenge after a bad signature, challenges completed by another app or network, a workflow read by its owner, hidden from another app and another address, network mismatches, `429` with retry headers, and the Redis counter and expiry.

## Not in this task

- Creating API keys and registering partner apps has no route yet. Keys are created with `createApiKey` from `@stacks-capital/database`; an admin surface belongs to a later task.
- Creating quotes, plans and workflows belongs to later tasks. `quotes:write`, `positions:read` and `webhooks:manage` exist as scopes but no route uses them yet.
- Sessions cannot be revoked through the API yet, and there is no refresh; a new sign in is needed after an hour.
- Client IPs come from the socket. Behind a proxy every browser caller would share one bucket per app, so trusted proxy headers need to be configured at deployment.
- `openapi:check` detects any schema change but does not classify changes as breaking or additive.
