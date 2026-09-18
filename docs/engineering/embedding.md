# Embedded components and partner example

| | |
|---|---|
| Task | I16 Embedded components and partner example |
| Requirements | SDK-01, PMF-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I12 earn comparison, I13 borrow, I14 swap |
| Date | 2026-09-18 |

Deliverable from the task page: export reusable UI and build a clean second app using SDK only; document integration and browser and server separation.

## Two halves of integration

A partner integrates Capital OS from two places, and each half has a reference in this repo.

| Half | Holds | Reference |
|---|---|---|
| Browser | A publishable client id, the connected wallet, and a wallet session after sign in | `apps/embed-example` (this task) |
| Server | An API key, if the partner quotes or reads on behalf of its users | `apps/partner-example` (the server program from the engine work) |

The browser never holds an API key and never talks to a provider or an adapter. Everything that needs a key (quoting, planning, provider reads) happens behind the API.

## Packages a partner uses

| Package | What it gives | Needs |
|---|---|---|
| `@stacks-capital/client` | Typed calls to the API, typed errors, retries and cancellation (I07) | Nothing |
| `@stacks-capital/react` | Hooks and a cache isolated per network and address (I08) | React 19 |
| `@stacks-capital/ui` | Widgets and the rules behind them (this task) | React 19, a `CapitalProvider` above each widget |

`@stacks-capital/ui` exports four widgets and the logic they are built from:

| Widget | Shows |
|---|---|
| `EarnComparison` | Supply markets grouped by asset, ranked only when comparable, with the reason when not (I12) |
| `QuoteSummary` | What is sent, expected and guaranteed, fees, warnings and expiry for a quote |
| `PositionsSummary` | The signed in address's positions, never counting a receipt twice (I09, I11) |
| `WorkflowHistory` | The signed in address's workflows, newest first (I15) |

The logic is exported too (`compareEarn`, `projectBorrow`, `swapView`, `scenarios`, `buildPortfolio`, `signIn`, `connectWallet` and the rest), so a partner can build their own components on the same rules without React.

`apps/web` now imports all of this from `@stacks-capital/ui` as well, so the Capital OS app and a partner's page run the same code.

## The partner example

`apps/embed-example` is Acme Wallet's page: its own header and layout, with Capital OS embedded in the middle.

```tsx
const client = createClient({ baseUrl, network, clientId: "pk_acme_live" });

<CapitalProvider client={client} address={wallet?.address ?? null}>
  <EarnComparison />
  <PositionsSummary signedIn={session !== null} />
  <WorkflowHistory signedIn={session !== null} />
</CapitalProvider>
```

Sign in is `connectWallet`, then `signIn` with `messageSigner`, then `client.withSession(token)`, all from the public packages.

Two guards keep it honest:

- **A boundary rule** (`embed-example-uses-public-packages-only`) fails CI if the app imports anything outside `client`, `react`, `ui` and `core`. A second rule keeps `ui` itself away from adapters, the engine, the database, config and fixtures.
- **A configuration guard** refuses to start when any `VITE_` value looks like an API key or a session token, because everything under `VITE_` ships in the bundle.

Run it with `pnpm embed:dev`. It serves on port 5174, which is the allowed origin of the second fixture tenant (`pk_other_sandbox`), so it runs as a separate partner from the main app on 5173 and sees none of its data.

## Integration steps

1. Register an app and its origins, and get a publishable client id (`pk_...`).
2. In the browser: `createClient` with the client id, wrap the page in `CapitalProvider`, drop in widgets.
3. To act for a user: connect their wallet, `signIn`, and use `client.withSession(token)`.
4. On the server, only if needed: an API key with the scopes required. See `apps/partner-example`.
5. Never put an API key in browser code. The client throws if one is passed in a browser, the API refuses a key sent with an `Origin` header, and the example refuses to start with one in its configuration.

## Tests

- `packages/ui/src/*.test.ts`: every rule the widgets use, moved here from the app with their tests unchanged.
- `apps/embed-example/src/config.test.ts` (4): publishable values read, an API key or session token anywhere in `VITE_` values refused, non browser values ignored, and a missing or wrong client id or network refused.
- The boundary rule was checked by adding an engine import to the example: CI fails.

## Unsupported and deferred

- Borrow and swap widgets are not exported as single components yet. Their rules are (`projectBorrow`, `swapView`); the screens around them still live in `apps/web`.
- No styling contract: widgets use plain class names (`panel`, `muted`, `warn`, `error`, `unavailable`). A theming API is a later decision.
- Packages are private workspace packages. Publishing them to a registry belongs to the release work (I19, I20).
- Registering apps and issuing client ids still has no route; it is done in the database today.
