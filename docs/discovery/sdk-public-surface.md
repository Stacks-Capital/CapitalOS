# Public SDK surface

| | |
|---|---|
| Task | Public SDK facade (quote → plan → validate) |
| Requirements | SDK-first architecture: partners and Everything Stacks use the same public client |
| Owner / reviewer | kenzman / IBK |
| Depends on | K03–K14 adapters. Does not implement I05, I06 or I10. |

The product is this client. `@stacks-capital/web` and partner apps must call `createCapitalOS`. They must not import protocol adapters or transaction builders.

## What the SDK does

```ts
import { createCapitalOS } from "@stacks-capital/sdk";

const os = createCapitalOS({ network: "mainnet", reads, owner });
const { quote, plan } = os.quoteAndPlan(intent);
const checked = os.validate(plan, quote, { sender: owner });
```

- Network is required. There is no default.
- `quote` / `plan` / `validate` are the write path. Plans are unsigned.
- `submit()` always throws. The host wallet broadcasts.
- Workflow helpers stop at `AWAITING_SIGNATURE`. Persistence is I05.
- Reads are injected. `loadLiveReads({ network: "mainnet" })` pulls Emily limits, Zest/USDCx vault state, and Granite sBTC LTV from Hiro. Pyth prices and an sBTC↔USDCx Bitflow pool are still unavailable, so those quotes fail closed.
- Persistence is I05. Live ingestion worker is I06. UI is I10.

Market routing is by market id (`sbtc.deposit`, `zest.sbtc.vault`, `granite.sbtc.isolated`, `bitflow.sbtc-usdcx`). Zest supply and Granite collateral stay incomparable.

## Evidence

`pnpm test` includes `packages/sdk/src/client.test.ts` and `liveReads.test.ts`. `pnpm sdk:check` uses fixtures. `pnpm sdk:check:live` hits Hiro/Emily.

## Still owned elsewhere

- I05 workflow persistence.
- I06 live reads / projection worker.
- I10 Everything Stacks UI.
- Host wallet signing (I02 prototype remains separate; SDK only classifies wallet errors).
