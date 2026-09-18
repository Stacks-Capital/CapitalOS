# Public SDK surface

| | |
|---|---|
| Task | Public SDK facade (validate unsigned plans) |
| Requirements | SDK-first architecture: partners and Everything Stacks use the same public client |
| Owner / reviewer | kenzman / IBK |
| Depends on | K03–K14 adapters and the server engine. Does not implement I07 HTTP client, I10 UI, or K16 staking. |

The browser product is this client. `@stacks-capital/web` and partner apps must call `createCapitalOS`. They must not import protocol adapters, `@stacks-capital/engine`, or transaction builders. Quotes and plans are minted by the Capital API (`POST /v1/quotes`, `POST /v1/plans`) using server-side Hiro/DIA reads.

## What the SDK does

```ts
import { createCapitalOS, parseQuote, parsePlan } from "@stacks-capital/sdk";

const os = createCapitalOS({ network: "mainnet" });
const checked = os.validate(parsePlan(plan), parseQuote(quote), { sender: owner });
```

- Network is required. There is no default.
- `validate` is the write-path check. Plans stay unsigned.
- `submit()` always throws. The host wallet broadcasts.
- Workflow helpers stop at `AWAITING_SIGNATURE`. Persistence is I05.
- Quote minting lives in `@stacks-capital/engine`, called from the API. `loadServerReads` pulls Emily limits, Zest vault state, Granite LTV, and DIA prices. A stale DIA feed or an unpinned Bitflow pool fail-closes. Pyth is not used.

Market routing is by market id (`sbtc.deposit`, `zest.sbtc.vault`, `granite.sbtc.isolated`, `bitflow.sbtc-usdcx`). Zest supply and Granite collateral stay incomparable. Onchain SIP-010 names are `sbtc-token`, `usdcx-token`, and Zest receipt `zft`.

## Evidence

`pnpm test` includes `packages/engine`, `packages/sdk`, and `apps/partner-example`. `pnpm partner:example` runs a small partner program: HTTP quote/plan, SDK validate, then a local host sign of the unsigned Stacks call (never broadcast). `pnpm partner:example:live` uses live Hiro/Emily/DIA reads. `pnpm sdk:check` uses fixtures. `pnpm sdk:check:live` hits Hiro/Emily/DIA. `POST /v1/quotes` and `POST /v1/plans` are in the OpenAPI document.

## Still owned elsewhere

- I07 partner HTTP client wrapping the API.
- I05 workflow persistence of minted quotes and plans.
- I10 Everything Stacks UI.
- K16 Bitcoin L1 lockup signing (staking stays disabled).
- Host wallet signing (I02 prototype remains separate; SDK only classifies wallet errors).
