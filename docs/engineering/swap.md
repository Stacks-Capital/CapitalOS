# Swap screen and quote expiry

| | |
|---|---|
| Task | I14 Swap screen and quote expiry |
| Requirements | SWP-01, WF-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I08 hooks, K13 swap routing adapter |
| Date | 2026-09-18 |

Deliverable from the task page: show route, minimum received, impact and expiry; require refresh before expired transaction approval.

## What the screen shows

| Shown | Where it comes from |
|---|---|
| Route | The plan the server built: each step's contract and function, in order |
| Sending and expected | The quote's input and expected output |
| At least | The quote's minimum output. A quote without one cannot be approved |
| Price impact | Computed against the oracle prices the platform reads (`GET /v1/prices`) |
| Expiry | The quote's own expiry, counted down every second |

Price impact is the distance between the quoted rate and the oracle rate in basis points, positive when the quote is worse for the user. When either price is missing or stale it reads "unknown" with the reason. An impact measured against a guessed price would be worse than none.

## Expiry and the refresh rule

Approving takes time: the request goes to the wallet, the user reads it, then signs. A quote that is valid when the button is pressed can be dead by the time it is signed, and the transaction would fail or execute on a stale rate.

So the screen keeps a live countdown and stops approval **before** expiry, not at it:

- More than 15 seconds left: the quote can be approved.
- 15 seconds or less: approval is disabled and the screen asks for a refresh.
- Expired: approval is disabled and the screen says to refresh.

Refreshing asks the server for a new quote, which resets the countdown. The API refuses an expired quote as well (`QUOTE_EXPIRED`, 409), so the rule holds even if a client ignores it.

## Tests

`packages/ui/src/swap.test.ts` (10): impact of zero on a fair quote, a positive impact when the quote is worse than the oracle, unknown impact when a price is missing or stale, no impact from an empty side, the route and amounts shown, quote warnings passed through, the countdown, refresh required inside the margin, an expired quote refused, and a quote refused when it is not executable or has no floor on what is received.

## Unsupported and deferred

- One pool and one direction: sBTC to USDCx, the market the registry lists. A reverse or multi hop route needs the adapter to return it.
- The USDC price feed has never been set on the DIA oracle, so impact is usually unknown in practice today. The screen says so rather than inventing a rate.
- Slippage is entered in basis points and passed to the quote. There is no preset or suggestion.
- No swap history: activity lives on the workflow screen.
