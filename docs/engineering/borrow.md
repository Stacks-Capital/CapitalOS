# Borrow and repayment screens

| | |
|---|---|
| Task | I13 Borrow and repayment screens |
| Requirements | BOR-01, WF-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I08 hooks, K12 borrow and repay execution |
| Date | 2026-09-18 |

Deliverable from the task page: build collateral and borrow inputs, projected health, repay and withdraw flows with all stale and insufficient balance states.

## What the screen shows

Four actions against one credit market: add collateral, borrow, repay, withdraw collateral. Each one projects what the position would look like afterwards before anything is signed: collateral and debt in USD, loan to value after the action, the liquidation threshold and the most that could still be borrowed.

The projection uses core's `projectedHealth`, so the screen and the protocol arithmetic agree.

## Where the inputs come from

`GET /v1/markets/{id}/risk` returns three things, each with its own provenance:

| Part | Source | When it is missing |
|---|---|---|
| Risk parameters (borrow LTV, liquidation LTV, buffer, decimals) | The protocol, read server side | Null, with the reason |
| Collateral and debt prices | `price_snapshots` from the worker (I06), currently the DIA oracle | Null and stale, with a warning |
| Current collateral and debt | `position_snapshots` from the decoder (I11) | Null, and health cannot be projected |

Prices are judged by when the oracle published them, not by when we read them, and the freshness limit is core's `ORACLE_MAX_AGE_MS` (3 minutes). This is strict on purpose: a borrow decided on a stale price can be liquidated immediately.

## States that block signing

Nothing is assumed. Each of these stops the action and says why:

- The amount is not a whole number of base units, or is zero.
- A price is missing or stale.
- The protocol's risk parameters could not be read.
- The current position is unknown, so the result cannot be projected. It is never treated as zero.
- The amount is more than the wallet holds (when the balance is known).
- Removing more collateral than the position holds, or repaying more than is owed.
- The projection lands above the borrow limit.

Two cases are notes rather than blockers: landing inside the safety buffer, which is allowed but close to the limit, and an unknown wallet balance, which means the amount could not be checked against it.

## Unsupported and deferred

- Wallet balances still have no endpoint, so the insufficient balance check only runs when a balance is supplied. The screen says when it could not check.
- Granite positions cannot be read from the registered contract (see docs/engineering/positions.md), so in practice health projection is blocked until that is resolved. The screen reports it rather than guessing.
- The USDC price feed on the DIA oracle has never been set, so debt side prices are unknown today. Again reported, not invented.
- One credit market only. More markets need the screen to take a market picker.
- No liquidation alerts or history; those belong with the risk screens (I15).

## Tests

`packages/ui/src/borrow.test.ts` (11): the direction each action moves, borrowing projected correctly, a borrow past the limit refused, the buffer warning, repay and collateral improving the position, stale and missing prices, missing risk parameters, an unknown position, invalid amounts, sending more than the wallet holds, an unknown balance noted rather than blocking, and removing more than is held.

`apps/api/test/integration/execution.test.ts`: the endpoint returns parameters with prices unknown before the worker has run, picks up a price once one exists, refuses a browser client and answers 404 for an unknown market.
