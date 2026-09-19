# Pilot and launch decision

| | |
|---|---|
| Task | K20 Pilot and launch decision |
| Requirements | PMF-01, OPS-01 |
| Owner / reviewer | kenzman / IBK |
| Depends on | K19 SDK release compatibility gate, I20 pilot support and release checklist |
| Date | 2026-09-19 |

Architecture launch rule (page 27): the product launches the verified surface, not the promised surface. This document is the go/no-go. I20 recorded evidence; it did not decide.

## Decision

| Question | Verdict |
|---|---|
| Production launch | **No-go** |
| Closed earn pilot with real mainnet funds | **No-go** until I20 B1, B4 and B5 |
| Sandbox partner certification (K19) | **Go** — Zest supply quote → SDK validate → `AWAITING_SIGNATURE` only |
| Partner webhooks | **Not certified** — they are not built |
| Testnet writes | **Stay disabled** |

Nothing found in I20 or K18 puts funds at risk: failures fail closed. That is not enough to put users on mainnet money.

## Verified surface vs promised surface

| Action | Network | Registry | Certification | Why |
|---|---|---|---|---|
| Zest supply | mainnet | enabled | **sandbox** | Partner program and SDK smoke. Host wallet broadcasts; SDK does not. |
| Zest withdraw | mainnet | enabled | not certified | Workflows do not move past `SUBMITTED` (I20 B1). |
| sBTC deposit / withdraw | mainnet | enabled | not certified | No product screen; no Bitcoin/Emily ingestion (I20 B2). |
| Granite collateral / borrow / repay | mainnet | enabled | not certified | Positions unread; DIA USDC unset; fail-closed in practice (I20 B3). |
| Bitflow swap | mainnet | enabled | not certified | Pool principal not pinned (I20 B6). |
| Every testnet write | testnet | disabled | disabled | Unverified test environments. |
| Stake | both | disabled | disabled | K16 exclusion. |

The machine-readable copy is `LAUNCH_DECISION` in `@stacks-capital/sdk`. `packages/sdk/src/launch.test.ts` fails if a disabled capability is certified, or if a sandbox row is not enabled in the registry.

## What a closed earn pilot still needs

From I20, at least:

- B1 — ingestion must link transactions so a supply can leave `SUBMITTED`
- B4 — terms, privacy, risk disclosures, support ownership
- B5 — on-call owner, protocol emergency contacts, an alert destination other than stdout

Until then, borrow and swap stay uncertified even though their registry rows are enabled. Operators who run a private demo should `ops:disable` granite and bitflow rather than present them as launched.

## What this does not do

- It does not change capability flags. Disabled stays disabled; enabled-but-uncertified stays fail-closed at quote time.
- It does not publish packages. K19 only proves they pack.
- It does not run I20 manual checks M1–M10. Those remain unrun and still required before any later go.

## Evidence

- This file
- `packages/sdk/src/surface.ts` (`LAUNCH_DECISION`)
- `packages/sdk/src/launch.test.ts`
- `pnpm sdk:compat`
- I20 [pilot checklist](pilot-checklist.md)
