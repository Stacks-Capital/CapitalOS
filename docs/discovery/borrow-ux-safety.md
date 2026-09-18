# Borrow UX safety integration

| | |
|---|---|
| Task | K15 Borrow UX safety integration |
| Requirements | BOR-01, WF-01 |
| Owner / reviewer | kenzman / IBK |
| Depends on | K12 Granite borrow/repay, I13 borrow and repayment screens |
| Date | 2026-09-18 |

Architecture §15: review health from the planned post-state, sign each explicit step, and treat partial completion as a real position.

I13 already projects health with core `projectedHealth` and blocks stale prices, unknown positions, and over-LTV borrows. K15 wires the protocol side of those rules so a quote cannot disagree with that screen.

## What this slice enforces

- Unknown Granite positions fail closed. Missing collateral/debt is not treated as zero.
- Repay cannot exceed current debt. `amount: "max"` is the protocol debt, including whatever I11 already accrued into that snapshot.
- Borrow fails if the USDCx vault is paused or the amount exceeds known vault liquidity.
- Quote snapshots carry LTV, max borrow, health, liquidity, pause and oracle time so the screen can refuse a paused or dry market after the server quote.
- Two-step `collateral-add` then `borrow` plans expose one unsigned step at a time. If collateral confirms and borrow is refused, the workflow parks as `ACTION_REQUIRED` / `FOLLOW_UP`. It is not `FAILED`, and the confirmed step is kept.

## Evidence

- `packages/core/src/borrowSafety.test.ts`
- `apps/web/src/borrow.test.ts` (pause, liquidity, repay-all)
- `packages/fixtures/src/credit-roundtrip.test.ts` (repay against debt, paused vault, unknown position)

I13's screen uses `nextBorrowStep`, `quoteSafety` and `oracleProvenance` before a wallet request. Collateral and borrow remain separate signatures.

## Still owned elsewhere

- Live Granite position reads (I11). Until those exist the screen stays blocked on unknown position.
- USDC/USD DIA feed (I06). Debt-side prices stay fail-closed when unset.
- I17 metrics, alerts and feature flags.
