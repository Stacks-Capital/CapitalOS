# SDK migration notes (0.1.0)

| | |
|---|---|
| From | `0.0.0` workspace packages |
| To | `@stacks-capital/*@0.1.0` release candidate |
| Task | K39 / I39 |

Packages stay **private**. This documents the partner contract for the first release candidate; it is not a registry publish.
For the complete step-by-step external developer guide, see the [Partner Integration Guide](partner-integration.md).

## Breaking

- **No default network.** `requireNetwork(undefined)` and any SDK entry that needs a network throw. Pass `"mainnet"` or `"testnet"` explicitly.
- **SDK never broadcasts.** `createStacks Capital(...).submit()` throws `UNSUPPORTED_ACTION`. The host wallet broadcasts after `assertReadyToSign` / `toWalletRequest`.
- **Staking stays disabled.** `executable("stake", …)` is false on both networks.
- **API envelope locked.** `schemaVersion` must be `"1.0"`. Clients that omit it fail closed.
- **Money stays strings.** Quote/plan wire quantities that arrive as JavaScript numbers are rejected.
- **Partner imports.** Do not depend on `@stacks-capital/adapters`, `engine`, `database`, or `fixtures`. Use `@stacks-capital/sdk`, `client`, `react`, `ui`, plus types from `core` / `wallets`.

## Non-breaking additions in 0.1.0

- `RELEASE_CANDIDATE_VERSION`, `RELEASE_PACKAGES`, `COMPATIBILITY_MATRIX` on `@stacks-capital/sdk`
- Complete sandbox entry (`supply`) and exit (`withdraw_supply` / `redeem`) in `@stacks-capital/partner-example`
- Isolated and revocable disposable test credentials in `apps/partner-example/src/disposable-test-account.ts`
- Plan validation / wallet gate hardening (K34)
- Workflow recovery helpers (`completeFromReconciliation`, `resumeHint`, …) (K35)
- Risk helpers (`interpretGraniteHealth`, `graniteProtectiveActions`, …) (K36)

## Supported combinations

| Dimension | Supported |
|---|---|
| Node | major 22 or 24 (`engines.node` `>=22`) |
| React | `^19.0.0` (peer on `react` / `ui`) |
| Wallets | Leather, Xverse |
| schemaVersion | `1.0` |

## Install from packed artifacts (no registry)

```sh
pnpm gate:k39   # packs every release package and proves a clean install
```

Until a registry publish lands, consume workspace packages or the tarballs produced by the gate.

## Partner path

Quote and plan come from the Capital API. The SDK only validates and holds workflow state through `AWAITING_SIGNATURE`:

### Entry Flow (Supply)
```ts
const os = createStacks Capital({ network: "mainnet" });
const checked = os.validate(parsePlan(plan), parseQuote(quote), { sender });
os.assertReadyToSign(parsePlan(plan), parseQuote(quote), { sender });
```

### Exit Flow (Withdraw Supply / Redeem)
```ts
const os = createStacks Capital({ network: "mainnet" });
const checked = os.validate(parsePlan(exitPlan), parseQuote(exitQuote), { sender });
os.assertReadyToSign(parsePlan(exitPlan), parseQuote(exitQuote), { sender });
```

See [apps/partner-example](../../apps/partner-example/src/program.ts) and [Partner Integration Guide](partner-integration.md) for complete implementations.
