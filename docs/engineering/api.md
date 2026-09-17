# API

| | |
|---|---|
| Task | I05 API skeleton and tenant access |
| Requirements | SDK-01, SEC-01 |
| Owner / reviewer | IBK / kenzman |
| Date | 2026-09-17 |

Deliverable from the task page: implement versioned API schemas, pagination, rate limits and session and key boundaries; reject cross tenant workflow reads.

This task lands in two parts. Part one, described here, is the skeleton: routing, schemas, envelope, errors, pagination and OpenAPI. Part two adds tenant access.

## Stack

| Piece | Version |
|---|---|
| Hono | 4.13.8 |
| `@hono/zod-openapi` | 1.6.3 |
| zod | 4.6.5 |
| `@hono/node-server` | 2.1.1 |

Routes declare zod schemas. The same schemas validate requests and generate the OpenAPI document (page 01).

## Commands

| Command | What it does |
|---|---|
| `pnpm api:dev` | Starts the API on `127.0.0.1`, port `API_PORT` (default 3000). Needs `DATABASE_URL` |
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
  | `PROVIDER_TIMEOUT` | 503 |
  | `INTERNAL` and anything unexpected | 500 |

  Unexpected failures return `INTERNAL` with a generic message and never expose internal details.
- **Pagination.** List routes take `limit` (1 to 100, default 20) and `cursor`. Cursors are opaque, name the list they belong to and hold the last key. Queries use keyset pagination on stable keys, and `nextCursor` is `null` on the last page. A tampered cursor or a cursor from another list is rejected.

## Routes

| Route | Returns |
|---|---|
| `GET /v1/markets` | Markets for a network with their per action capabilities, ordered by market id |
| `GET /v1/capabilities` | Capabilities for a network, ordered by market and action |
| `GET /v1/openapi.json` | The OpenAPI 3.1 document |

Registry reads come from `@stacks-capital/database`, whose query helpers the worker can reuse.

## Tests

- Unit (`apps/api/src/app.test.ts`), with a database stub that fails if it is reached: missing or unknown network, page size limits, tampered and foreign cursors, unknown routes, unexpected errors hidden behind `INTERNAL`, cursor round trip and the served OpenAPI document.
- Integration (`apps/api/test/integration`), against a migrated and seeded schema: mainnet markets in the envelope, paging through all markets with no gaps or repeats, every testnet action disabled, and capability paging that matches the database.

## Not in part one

- API keys, publishable client ids and allowed origins, wallet nonce sessions, rate limits, tenant checks and `GET /v1/workflows/{id}` come in part two.
- Creating quotes, plans and workflows belongs to later tasks.
- CORS headers are not set yet; they come with allowed origins in part two.
- `openapi:check` detects any schema change but does not classify changes as breaking or additive.
