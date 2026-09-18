# Risk and activity screens

| | |
|---|---|
| Task | I15 Risk and activity screens |
| Requirements | RSK-01, POS-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I11 position decoder, K14 protocol risk arithmetic |
| Date | 2026-09-18 |

Deliverable from the task page: show protocol risk, concentration, scenario assumptions and workflow history; label unavailable calculations.

## Four panels

| Panel | What it shows | Source |
|---|---|---|
| Protocol risk | Borrow limit, liquidation threshold, safety buffer, and the collateral price with its source and staleness | `GET /v1/markets/{id}/risk` |
| Concentration | Share of holdings by market and by protocol | Positions from the decoder (I11) |
| If the price moves | Loan to value and health factor at price moves of -10%, -20%, -30% and -50%, and whether each would liquidate | Core's `computeHealth` with the collateral price shifted |
| Activity | Workflows newest first with state, next action and how many steps are recorded | `GET /v1/workflows` |

## Labelling what cannot be calculated

Every calculated number is either a value or an explicit unavailable with a reason. Nothing falls back to zero.

Concentration is unavailable when:

- No positions have been projected for the address yet.
- Any position in the set is unknown. A share of an unknown total means nothing, so the whole calculation is withheld and the markets responsible are named.
- Positions are held in different assets. Quantities in different assets cannot be added.
- Everything held is zero, so there is nothing to compare.

Scenarios are unavailable, all of them together, when the risk parameters cannot be read, the current position is unknown, a price is missing, or a price is stale. The reason is shown in each row rather than an empty cell.

## Assumptions are shown, not implied

A scenario without its assumptions is just a number. The panel states them: which feed the collateral price comes from, when that price was published, the liquidation threshold it is measured against, and that only the collateral price moves while debt, interest and protocol parameters are held still.

`wouldLiquidate` returns false for a scenario that could not be worked out, so an unavailable calculation never reads as a safe one.

## Workflow history

`GET /v1/workflows` lists the caller's workflows, newest first, with keyset pagination on the creation time. A wallet session sees only its own address. An API key sees its own app, or one address within it. Another tenant gets an empty list, the same as having no workflows, which matches how a single workflow read behaves.

This endpoint did not exist and no task assigned it. It landed here because the activity panel needs it.

## Tests

`apps/web/src/exposure.test.ts` (10): shares by market, unavailable when a position is unknown with the market named, refusing to add different assets, nothing to compare, debt excluded from exposure, scenario values and assumptions, which scenarios liquidate, all five reasons a scenario is unavailable, custom price moves, and no liquidation claimed from an unavailable scenario.

`apps/api/test/integration/execution.test.ts`: the list returns the caller's workflows with their step counts, and another tenant sees an empty list.

## Unsupported and deferred

- Concentration is measured in token quantities within one asset. A portfolio spanning assets needs prices for each, which the USDC feed does not currently provide.
- Scenarios move only the collateral price. Rate moves, debt price moves and time based interest are not modelled.
- One credit market. More markets need the panel to loop over them.
- No alerts: the screen shows the state when it is opened, and nothing is pushed.
