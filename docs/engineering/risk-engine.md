# Risk engine and protective actions (K36)

| | |
|---|---|
| Tasks | K36 Complete risk engine and protective action semantics |
| Owner / reviewer | Kenzman / IBK |
| Depends on | K28, K30–K33, I25 |

Core owns protocol-tagged health interpretation, evidence-backed stress, concentration/liquidity gates and safe action lists. Screens consume these helpers; they do not invent prices or health factors.

## Calculation version

Every report carries `RISK_CALCULATION_VERSION` (`risk@1.0.0`). Bump it when HF meaning, scenario assumptions or protective-action rules change.

## Granite credit health

`interpretGraniteHealth` documents the protocol reading of K14 arithmetic:

- `HF_bps = (collateralUsd × ltvLiqBps) / debtUsd` — **10000 = HF 1.0 = liquidation threshold**
- `healthy` requires HF ≥ 10000 **and** LTV ≤ borrow LTV
- `withinBuffer` is advisory only
- Zero debt uses sentinel HF 100000 bps (10.0), not an invented infinity
- Stale oracles fail closed — numbers are unavailable, not “safe zeros”

## Stress and concentration

- `stressGraniteCollateral` shifts only an evidenced collateral oracle by declared bps; stale/missing/non-positive shifts are withheld
- `concentrationByQuantity` is same-asset quantity shares; mixed assets or unknown quantities fail closed
- `borrowLiquidityGate` treats null vault liquidity as insufficient

## Protective actions

`graniteProtectiveActions` returns allow/deny for `supply`, `borrow`, `repay`, `withdraw_supply` from health, pause and liquidity evidence. Zest earn and Bitflow return `unsupportedCreditRisk` — no invented HF.

## SDK

```ts
import {
  RISK_CALCULATION_VERSION,
  interpretGraniteHealth,
  stressGraniteCollateral,
  graniteProtectiveActions,
  concentrationByQuantity,
} from "@stacks-capital/sdk";
```

## Tests

```sh
pnpm --filter @stacks-capital/core test
pnpm --filter @stacks-capital/sdk test
pnpm --filter @stacks-capital/ui test
```
