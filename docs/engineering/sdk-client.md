# SDK HTTP client and React hooks

| | |
|---|---|
| Tasks | I07 SDK HTTP client and typed errors, I08 React hooks and cache isolation |
| Requirements | SDK-01, WF-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I05 API skeleton and tenant access |
| Date | 2026-09-18 |

Deliverables from the task pages. I07: typed responses, request cancellation, retries for safe reads and error taxonomy; no secret in browser bundle. I08: market, position and workflow hooks keyed by network and address; invalidate stale quotes on wallet switch.

Two packages: `@stacks-capital/client` is framework free and talks to the API, `@stacks-capital/react` is a thin layer of hooks over it. The client is separate from `@stacks-capital/sdk`, the quote and plan surface, which keeps API access and quote math in their own packages; the SDK can re-export the client later.

## Using the client

```ts
import { createClient } from "@stacks-capital/client";

// In a browser: publishable client id, plus the Origin the browser sends.
const client = createClient({ baseUrl: "https://api.example", network: "mainnet", clientId: "pk_live_acme" });

const markets = await client.markets({ limit: 20 });
const signedIn = client.withSession(session.token);
const workflow = await signedIn.workflow("wf_123");
```

| Method | Route | Retried |
|---|---|---|
| `markets`, `allMarkets` | `GET /v1/markets` | yes |
| `capabilities` | `GET /v1/capabilities` | yes |
| `workflow(id)` | `GET /v1/workflows/{id}` | yes |
| `challenge({ address })` | `POST /v1/auth/challenge` | no |
| `verify({ nonceId, publicKey, signature })` | `POST /v1/auth/verify` | no |
| `withSession(token)` | none, returns a client bound to that session | |

Every call sends `network`, so nothing runs on a network the caller did not name. Every answer returns the page 01 envelope's context (`requestId`, `network`, `observedAt`, `stale`, `warnings`, and the block reference when there is one), so a caller can show staleness and quote a request id in support.

## No secret in the browser

- A client id is publishable. It works only from an origin the app has listed, and it can read the registry and start a sign in.
- An API key is a secret. `createClient` throws `CapitalConfigError` when one is passed in a browser, before any request is sent. The API refuses a key that arrives with an `Origin` header as well, so the rule is enforced on both sides.
- Credentials only ever travel in headers, never in a URL, so they cannot leak through logs or a referrer.
- A wallet session token is returned once by `verify` and is what browser code should hold after sign in.

## Errors

| Error | When |
|---|---|
| `CapitalApiError` | The API answered with an error body. Carries `code`, `status`, `requestId`, `retryAfter` and `errorClass` |
| `CapitalTransportError` | `timeout`, `aborted`, `network` or `protocol`. Nothing came back, or what came back is not our contract |
| `CapitalConfigError` | The client was built in a way that cannot work or would leak a secret. Thrown before any request |

`errorClass` follows core's taxonomy (`retryable_read`, `requote`, `user_action`, `investigation`), so callers branch on the class rather than on status codes. Transport codes map on top of it: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND` and `INVALID_REQUEST` are `user_action`, `TEMPORARY_UNAVAILABLE` is `retryable_read`, `INTERNAL` and anything unknown are `investigation`.

## Retries and cancellation

- Only safe reads are retried, three attempts by default. A `POST` is sent once, because a sign in challenge can be answered only once.
- Retried: `retryable_read` errors (`RATE_LIMITED`, `TEMPORARY_UNAVAILABLE`, `PROVIDER_TIMEOUT`) and transport timeouts and network failures. Never retried: anything the caller must fix, and anything the caller cancelled.
- `retry-after` from the API is honoured exactly. If the API asks for longer than `maxRetryAfterMs` (10 seconds), the client reports the error instead of holding the request open. Otherwise it backs off exponentially from 200ms, capped at 2 seconds, with jitter.
- Every method takes a `signal`. The caller's signal and the client's own timeout (15 seconds by default) are combined, and the two cases are reported separately: `aborted` for the caller, `timeout` for the deadline.

## Hooks and cache isolation

```tsx
<CapitalProvider client={client} address={wallet.address}>
  <Portfolio />
</CapitalProvider>
```

```ts
const markets = useMarkets({ limit: 20 });   // { status, data, error, isLoading, refresh }
const workflow = useWorkflow(workflowId);    // null id means nothing is read yet
```

- Every cache key starts with the network and the address (`mainnet|SP1|markets`), so nothing one address sees can reach another, and a signed out visitor has their own scope (`mainnet|anonymous`).
- Changing wallet or network drops every entry outside the new scope, so a quote from the previous wallet can never be used. Quotes can also be dropped on their own with `cache.dropQuotes()`.
- One request per key: two components asking for the same thing join one load. A fresh entry (30 seconds by default) is served from cache, and `refresh()` reads again anyway.
- A failed reload keeps the last good data and reports the error next to it, so a screen does not go blank when a provider fails.
- A load that finishes after its entry was dropped is discarded, so a wallet switch cannot be undone by a slow answer.

`useCapitalQuery(key, loader)` is the generic hook the others are built from, for resources that do not have a hook yet.

## Decision: where quoting runs

Page 01 describes a server side quote and plan service. Kenzman's SDK on main takes reads as an injected dependency, so `createStacks Capital` can run in either place. We decided to quote on the server, and the API will run his SDK rather than duplicate the math. Recorded here because it shapes the client, the hooks and the earn screens (I10).

Why:

1. The I04 schema already assumes it. `quotes` and `plans` are tables, `workflows.quote_id` points at one, and a quote can only exist for an action the registry lists. Quoting in the browser leaves those empty and a workflow cannot name the quote it executed.
2. Quoting in the browser means publishing adapter shaped reads (vault state, risk parameters, oracle prices, swap quotes) as a public API, versioned against adapter versions. One quote endpoint is a smaller and steadier contract.
3. Page 04 requires a reviewer to reproduce what was done. A stored quote carrying its inputs, amounts, expiry and adapter and registry versions can be reproduced and reconciled. One computed in a browser cannot.
4. Expiry belongs on the server. Core already has `QUOTE_EXPIRED` and the requote class, and a server owned expiry stops a wallet signing a plan built from a stale quote. Otherwise every partner reimplements it.
5. Provider cost stays bounded: one read per quote for everyone, instead of every browser session reading through us.

What it means in practice:

- `POST /v1/quotes` and the plan it returns belong to a later task; nothing in I07 or I08 depends on it landing first.
- The API imports `@stacks-capital/sdk` and calls `createStacks Capital` with server side reads, so the quote math stays in one package.
- The `quotes:write` scope on API keys (I05) is what that endpoint will check.
- The client gains `quote()` when the endpoint exists. The cache already reserves the `quote` resource and drops it on a wallet switch, so the hook is a loader away.

If the team prefers quoting in the browser, the change is small on this side: the hook calls `createStacks Capital` instead of the endpoint, and the API grows reads endpoints instead of a quote endpoint.

## Tests

- `packages/client/src/client.test.ts` (21): the browser guard, the config guards, headers and that no credential reaches the URL, the envelope and its context, cursor following, sign in, typed errors and the class table, protocol failures, retry and no-retry paths, honouring and refusing `retry-after`, backoff, cancellation, timeout and no retry after cancelling.
- `packages/client/src/cache.test.ts` (12): key rules, freshness, deduplication, failure keeping old data, isolation between addresses and networks, dropping quotes, notifying subscribers and discarding a load that arrived after its entry was dropped.
- `packages/react/src/hooks.test.ts` (8): hooks rendered in jsdom with React 19, covering load and share, refresh, failure with previous data, one entry per address, wallet switch dropping the old scope and its quote, signed out separation, a null id waiting, and the provider guard.
- `apps/api/test/integration/client.test.ts` (5): the client driving the real API, covering reads, a full wallet sign in with a generated key, a cross tenant read reported as not found, a missing scope and an unknown client id, and a rate limit reported with its wait.

## Unsupported and deferred

- **Position hooks are not built.** There is no `GET /v1/positions` yet: position projections are I11 and the route is not in I05. The cache already reserves the `positions` resource, and `useCapitalQuery` covers it in one line once the route exists.
- **Quote hooks are not built**: the quote endpoint does not exist yet (see the decision above). The wallet switch rule that protects quotes is implemented and tested today with cache entries.
- No sign in hook: signing needs a wallet connection, which is the I02 prototype and the wallet shell in I09. The client's `challenge` and `verify` are what such a hook would call.
- Hooks do not cancel a shared in flight read when a component unmounts, because another component may be waiting on the same load. Direct client calls take a `signal` for that.
- No React Native or server rendering path yet. The hooks need a DOM.
- The client does not re-export from `@stacks-capital/sdk`. Partners currently import `@stacks-capital/client` for API access and the SDK for quoting.
