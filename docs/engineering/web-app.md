# Wallet shell and portfolio screens

| | |
|---|---|
| Tasks | I09 Wallet shell and portfolio screens, I10 Earn review and progress UI |
| Requirements | POS-01, WF-01, EARN-01, EARN-02 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I02 wallet feasibility, I06 worker, I08 hooks, K06 and K09 adapters |
| Date | 2026-09-18 |

Deliverable from the task page: build navigation, connect, balances and partial data states; avoid receipt and underlying double counting.

`apps/web` is a Vite 8 and React 19 app. It reads through `@stacks-capital/react`, which reads through `@stacks-capital/client`. It never talks to a provider or an adapter directly.

## Commands and configuration

| Command | What it does |
|---|---|
| `pnpm web:dev` | Runs the app against `VITE_API_BASE_URL` |
| `pnpm build` | Builds the wallet prototype and this app |

Copy `apps/web/.env.example` to `apps/web/.env.local`. Only publishable values belong there, because everything in it ships in the bundle:

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | `http://127.0.0.1:3000` | The API to read from |
| `VITE_CLIENT_ID` | none, required | Publishable client id. The API accepts it only from an origin the app allows |
| `VITE_NETWORK` | `mainnet` | Network for every read |

There is no API key here. The client throws if one is ever passed in a browser (I07), and the API refuses a key that arrives with an `Origin` header (I05).

## Shell

- Navigation: Portfolio, Markets, Activity.
- Connect: Leather and Xverse are detected where each actually lives, `LeatherProvider` and `XverseProviders.BitcoinProvider` (I02 finding). Xverse is asked with a capitalised network, because lowercase makes it hang (I02 finding).
- Sign in: connect, then `POST /v1/auth/challenge`, the wallet signs that exact text, then `POST /v1/auth/verify` returns a session. The address must belong to the app's network, checked before the wallet is asked to sign, so a mainnet wallet cannot sign into a testnet app.
- A rejected signature is reported as the user's choice (`USER_REJECTED`), not as a failure.
- Connecting a different wallet clears the session, and the hooks drop the previous address's cache (I08).

## Partial data states

Every panel shows one of four things: loading, ready, unavailable, or an error. They are separate on purpose.

| State | Shown when |
|---|---|
| unavailable | The data has no source yet. The panel says so and names why |
| error | The read failed and there is nothing to show. The message says what to do, whether retrying helps, and carries the request id |
| ready, marked stale | A refresh failed, or the API said the data is stale. The old data stays on screen with the reason above it |
| ready | Fresh data, plus any warnings the API attached |

A missing amount is never drawn as `0`, because `0` is a real balance. It reads "unknown".

Balances and positions are unavailable today: there is no balances or positions endpoint, and position decoding is I11. The panels say that rather than showing an empty portfolio that looks like nothing is held.

## Receipt and underlying double counting

A vault receipt (for example `zft`) and the position it represents are the same money. Counting both doubles it. `buildPortfolio` in `src/holdings.ts` applies these rules:

1. A balance whose asset is a market's receipt asset is shown as a receipt row and never counts toward a total. Receipt units are not underlying units.
2. When the protocol also reports a supplied position for that market, the receipt row says it is already shown by the position.
3. When it does not, the receipt row says its value needs the vault share rate, rather than guessing one.
4. Debt is listed but never added to what the wallet owns.
5. A total with any unknown part is unknown, with the reasons attached. It is never a partial sum presented as complete.

## Earn flow (I10)

Deliverable from the task page: compare, review, signature, confirmation and recovery states; a reload resumes the correct pending step.

The write path the flow needs did not exist. No task in the split assigned it, so it landed here (see the PR). The API grew three routes, and quoting runs the SDK on the server, as decided in docs/engineering/sdk-client.md:

| Route | What it does |
|---|---|
| `POST /v1/quotes` | Runs `createCapitalOS` with server side reads, stores the quote and its plan, returns both |
| `POST /v1/workflows` | Turns a quote into a workflow at `AWAITING_SIGNATURE` with its steps. One workflow per idempotency key |
| `POST /v1/workflows/{id}/signature` | Records what the wallet answered and moves the workflow |

Stages follow the workflow's own state, never the screen's memory:

| Workflow state | Stage |
|---|---|
| none, `DRAFT`, `QUOTED` | review |
| `AWAITING_SIGNATURE` | signing |
| `SUBMITTED`, `CONFIRMING`, `STEP_CONFIRMED`, `RECONCILING` | confirming |
| `COMPLETED` | done |
| `BROADCAST_UNKNOWN`, `ACTION_REQUIRED`, `MANUAL_REVIEW`, `REORGED`, anything unknown | recovery |

Rules the flow keeps:

- A quote that expired or is not executable cannot be signed. The button is disabled and the reason is shown.
- The plan is sent to the wallet exactly as the server built it, post conditions included. Arguments are encoded, nothing is added.
- Whatever the wallet answers is forwarded unchanged. A result without a transaction id becomes `BROADCAST_UNKNOWN` and the screen says a human has to look, because resubmitting could move the money twice.
- The pending workflow and step are remembered per network and address, so a reload returns to the same step and another wallet never sees it. A finished or failed flow is forgotten.

## Tests

`node --test apps/web/src/*.test.ts`, 23 tests, no browser needed:

- `holdings.test.ts`: the five rules above, including a wallet balance plus a supplied position totalling once with the receipt excluded, a receipt with no position, an unknown part making a total unknown, and debt staying out of the total.
- `earn.test.ts`: the stage table including unknown states going to recovery, the pending step remembered per network and address and surviving missing, broken or nonsense storage, review amounts and expiry, refusing to sign an expired or blocked quote, and the wallet request built from a plan step with its post conditions.
- `shell.test.ts`: wallet detection per wallet, reading a Stacks address out of several answer shapes (and refusing a Bitcoin one), Xverse's capitalised network, sign in end to end, a wallet on the wrong network refused before signing, a rejected signature classified as a user action, a failed challenge never reaching the wallet, and the panel state table including keeping stale data on screen.

The screens themselves are thin: every rule they follow lives in a tested module.

## Unsupported and deferred

- No balances or positions endpoint yet, so those panels are unavailable. They are one hook each once the routes exist.
- Earn covers `supply` only. Borrow, repay and swap screens are I13 and I14, and sBTC deposit needs the Bitcoin flow.
- Component rendering is not unit tested. Node's test runner cannot strip JSX, so the logic lives in `.ts` modules that are tested, and the `.tsx` files stay declarative. A browser test runner would be a separate decision.
- The session lives in memory only. A page reload signs the user out again, although the pending step is remembered and shown once signed back in.
- Confirmation does not stream. The screen re-reads the workflow when asked, and the worker (I06) is what moves it forward.
- No styling system, just a small stylesheet in `index.html`.
