# Earn comparison and rate breakdown

| | |
|---|---|
| Task | I12 Earn comparison and rate breakdown |
| Requirements | EARN-01, EARN-02 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I10 earn flow, I11 position decoder and rewards |
| Date | 2026-09-18 |

Deliverable from the task page: show supplied asset, base and incentive rate, fees, liquidity and withdrawal conditions; never rank incomparable strategies silently.

## Where the numbers come from

`GET /v1/earn/options` serves one row per market that can be supplied into, joining facts that already exist:

| Column | Source |
|---|---|
| Supplied and receipt asset | Registry (I04) |
| Supply and withdrawal state, with the reason | Capabilities (I04) |
| Base rate | Latest market snapshot from the worker (I06) |
| Incentive rate | Latest reward snapshot (I11) |
| Liquidity and capacity | Latest market snapshot (I06) |
| Fees | Not here: fees depend on the amount and come with the quote (I10) |

A market with no snapshot yet returns null rates and null liquidity, marked stale. Nothing is filled in with zero.

## Ranking rules

The API serves facts; ranking is a decision, so it lives in the app and is tested there (`packages/ui/src/compare.ts`).

1. **Options are grouped by the asset they supply.** Two markets supplying different assets are never ranked against each other, and the screen says so.
2. **Within a group, rank is base rate plus incentive rate**, added at the finer of the two scales.
3. **An option is listed but never ranked** when supply is not enabled, the market is paused, no withdrawal action is listed, withdrawal is not enabled, no rate has been read, the reading is stale, or the reading is older than 15 minutes. Each case carries its reason.
4. **A missing incentive rate is not treated as zero.** The option is still ranked on its base rate, with a visible note that the incentive is unknown.
5. **Unknown liquidity is a note, not a blocker.** It does not change the rate, but it changes whether the size is available.

A strategy you cannot leave is not the same product as one you can, which is why withdrawal conditions block ranking rather than becoming a footnote.

## Open question

`marketsComparable` in core treats two markets as comparable only when protocol **and** action match, so no two protocols could ever be compared. That rule is right for "Zest supply versus Granite collateral", but it also rules out comparing two supply vaults, which is what an earn comparison is for. This screen groups by supplied asset and action instead. Worth agreeing which rule is canonical, and whether core's should loosen.

## Tests

`packages/ui/src/compare.test.ts` (16): rate addition and comparison across scales, percentage formatting, ranking by base plus incentive, separate groups per supplied asset, each of the seven reasons an option is not ranked, an unrankable option staying visible below the ranked ones, an option with no supplied asset grouped alone, and unknown liquidity noted without blocking.

`apps/api/test/integration/execution.test.ts`: the endpoint lists only markets that can be supplied into, and leaves rates and liquidity unknown when no worker has run.

## Unsupported and deferred

- Fees are not part of the comparison. They depend on the amount, so they appear with the quote.
- Rates are shown as the protocol reports them, with no annualisation or compounding.
- No history: the screen shows the latest reading, not a trend.
- Comparison covers supply markets. Borrow and swap have their own screens (I13, I14).
