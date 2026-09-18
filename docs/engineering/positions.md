# Position decoder and rewards projections

| | |
|---|---|
| Task | I11 Position decoder and rewards projections |
| Requirements | POS-01, EARN-02 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I06 worker, K11 second lending adapter |
| Date | 2026-09-18 |

Deliverable from the task page: normalize both protocols and reward timestamps; reconcile principal, debt and receipt amounts against chain fixtures.

## What the decoder does

The worker reads what each market can say about an address, then normalises it into `position_snapshots`:

| Rule | Why |
|---|---|
| A vault receipt balance is converted to underlying with the vault's own `convert-to-assets` | Shares and underlying are not the same money. 1.0 share was worth 1.00054938 sBTC on 2026-09-18 |
| When the share rate cannot be read, the position stays in receipt units and says so | Better an honest receipt balance than an invented underlying one |
| A quantity the adapter defaulted to zero because it had no read is stored as null with a warning | Zero is a real balance (page 01) |
| A position kind the registry does not know is stored as unknown, naming the kind | Nothing is guessed into a known kind |
| Collateral and debt in one market keep separate protocol keys | Two positions in one market must not merge |
| Every row carries its deployment, adapter version, calculation version and block | Page 01 data model |

Rewards land in `reward_snapshots` (migration `0008_rewards.sql`): the vault's points rate in basis points, with the time the vault itself last updated it. A rate older than a day is stale with the age in its warning, and a rate that cannot be read is null with the reason.

## Normalising time

Sources report time in their own unit, so everything is converted to a real instant before it is stored:

| Source | Unit | Example |
|---|---|---|
| Zest vault `get-last-update` | seconds | `1789718028` is 2026-09-18T07:53:48Z |
| DIA oracle `get-value` | milliseconds | `1789718028000` is the same instant |

A zero or unreadable timestamp is null with a warning, never the epoch.

## Serving positions

`GET /v1/positions?network=&owner=` returns the latest snapshot per position, with the market's reward rate beside it. A wallet session reads its own address only; an API key needs `positions:read` and must name the owner. A browser client id cannot read positions at all.

The portfolio screen now uses them, so the panel I09 had to leave unavailable shows real positions. Wallet balances are still unavailable: there is no balances endpoint.

Positions are projected for addresses the platform already knows, which today means anyone who started a workflow.

## Tests

- `apps/worker/src/positions.test.ts` (13): receipt converted to underlying, receipt kept in receipt units when the rate is missing, collateral and debt kept apart, deployment and versions carried, an adapter's default zero stored as unknown, a real zero kept, an unknown kind refused, an unlisted market skipped, staleness passed through, seconds and milliseconds read as the same instant, a rate with its update time, a stale rate, and an unreadable rate.
- `apps/worker/test/integration/worker.test.ts`: a tick projects the vault position in underlying units and stores every market without a per address read as unknown with a warning, and projects the reward rate with its update time.
- `apps/api/test/integration/execution.test.ts`: the endpoint serves a projected position, keeps an unknown one unknown, and refuses a key that does not name an owner.

## Findings

1. **The adapters report a missing read as `0`.** `readPositions` in both adapters falls back to `"0"` when `reads.balances` or `reads.position` is absent, so a missing read is indistinguishable from an empty position. The worker works around it by tracking whether a read happened, but the adapters should return an unknown `DataPoint` instead.
2. **Zest reports its supplied position in receipt units.** `readPositions` returns `reads.balances.zsbtc`, which is `zft` shares, labelled `supplied`. Anything adding that to an underlying balance would double count. The worker converts it; the adapter should either convert or label the units.
3. **Granite positions cannot be read from the registered contract.** `v0-8-market` exposes only `index-cache`, `last-update` and `liquidation-grace-periods` as maps, and no per address getter, so collateral and debt for an address are unavailable. `reads.position` is only ever filled by fixtures today. Which contract holds user positions?
4. **`protocol_key` has two conventions.** The I04 fixtures use the owner address; the decoder uses `<marketId>:<kind>`. Both survive as separate positions, which is correct but confusing. Worth agreeing on one.

## Unsupported and deferred

- Wallet balances have no endpoint, so the portfolio still cannot show what sits in the wallet itself.
- Reward accruals per address are not projected: no protocol read exposes them yet. Only market wide rates are stored.
- Granite positions stay unknown until finding 3 is answered.
- Positions are projected only for known owners, once per tick. There is no subscription or on demand refresh.
