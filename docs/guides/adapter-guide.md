# Adapter guide

How to add a protocol, or a new action on an existing one. An adapter is the only code that knows a protocol's contracts: everything above it (engine, API, apps) works with markets, quotes and plans.

## Where an adapter sits

```
config (contracts, capabilities)
   ↓
adapters (one per protocol and action)  ←  reads (AdapterReads, loaded server side)
   ↓
engine (createExecutionEngine: quote, plan, validate)
   ↓
API  →  client, react, ui  →  apps
```

Boundary rules in `.dependency-cruiser.cjs` keep this one way: the web app, the SDK, `ui`, the partner program and the partner example must not import adapters or the engine. Quotes and plans are minted on the server only.

## The interface

`ProtocolAdapter` in `packages/adapters/src/types.ts`:

| Method | Must do |
|---|---|
| `describeCapabilities` | Return the registry records for this protocol on this network |
| `listMarkets`, `getMarket` | One market per action, with state and warnings from the registry |
| `readPositions` | Return a `DataPoint`, marked stale or unknown when the read is missing |
| `quote` | Price an intent from `AdapterReads`. Refuse with a typed error, never guess |
| `buildPlan` | Unsigned contract calls with post conditions in deny mode |
| `validatePlan` | Check a plan against its quote, network, sender, expiry and registry version |
| `decodeEvents` | Turn raw chain events into canonical activity |
| `reconcile` | Compare expected and observed results, with warnings when they differ |
| `explainRisk` | Disclosures, variables and alerts for the risk panel |

`packages/adapters/src/zest/earn.ts` is the smallest complete example.

## Steps

1. **Contracts.** Add each contract to `CONTRACTS` in `packages/config/src/deployments.ts` with its protocol, label, network, contract id, the revision it was verified at, and its role. Add token asset names to `FUNGIBLE_ASSET_NAME`.
2. **Capabilities.** Add one `CAPABILITIES` record per action and network, with a state and a reason. Start as `disabled` with the reason it is not ready. Only enable an action after its contract, post conditions and wallet support are verified, and cite the evidence in the reason.
3. **Reads.** If the adapter needs chain data, add a field to `AdapterReads` in `packages/adapters/src/reads.ts` and load it in `packages/engine/src/serverReads.ts`. Add fixture values to `MAINNET_READS` and `TESTNET_READS` in `packages/fixtures`.
4. **The adapter.** Create `packages/adapters/src/<protocol>/<action>.ts`, export it from `packages/adapters/src/index.ts`, and give it a market id constant (`<protocol>.<asset>.<kind>`) and a version (`<protocol>-<action>@0.1.0`).
5. **Engine.** Register the market id in the `adapters` map in `createExecutionEngine` (`packages/engine/src/engine.ts`).
6. **Registry and fixtures.** Add the adapter to `sandboxAdapters` in `packages/fixtures`. The seed builds the markets and capability rows from it, so `pnpm fixtures:seed` puts the new market in the database.
7. **Worker.** If the market has onchain state to project (rates, caps, pause flags, positions), add the reads to `apps/worker/src/markets.ts` or `positions.ts`. A contract whose read surface is not known is projected as unknown with a warning.
8. **Docs.** Regenerate what is generated: `pnpm openapi:write` if a schema changed, `pnpm docs:errors` if an error code was added.

## Rules an adapter must keep

- **Unknown is never zero.** A missing read is `null` with a warning, never `0`. A zero balance and an unknown balance mean different things to a user.
- **Fail closed.** A disabled capability, a stale oracle, a cap reached or an expired quote is refused with its typed error (`CAPABILITY_DISABLED`, `ORACLE_STALE`, `CAP_REACHED`, `QUOTE_EXPIRED`). The registry state is checked on every quote and plan, and operator overrides can only make it stricter.
- **Deny mode post conditions.** Every plan lists what may leave the wallet. A minimum output is rounded down, never up.
- **No hidden network switch.** A plan carries its network and is refused on the other one.
- **Integer arithmetic only.** Amounts are strings of base units; use `mulDiv` and `parseQuantity` from `@stacks-capital/core`.

## Tests

- Add cases to `packages/adapters/src/adapters.test.ts`: a quote on mainnet, a refusal where disabled, the plan's post conditions, and the min out rounding.
- Add a case to `packages/config/src/deployments.test.ts` that pins the new contract ids and the capability states per network.
- `pnpm test:integration` exercises the market through the API, including operator overrides.
- Run `pnpm run ci` before opening a pull request. `pnpm boundaries` fails if the new code imports across a boundary.
