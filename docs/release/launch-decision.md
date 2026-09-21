# Pilot and launch decision (K20 / K40)

| | |
|---|---|
| Tasks | K20 Pilot and launch decision; K40 Own pilot, production go/no-go and rollback decision |
| Owner / reviewer | Kenzman / IBK |
| Depends on | K37–K39, I20, I40 |
| Date | 2026-09-21 |

Architecture launch rule: ship the verified surface, not the promised surface. This document is the go/no-go. Machine-readable copy: `LAUNCH_DECISION` in `@stacks-capital/sdk`.

## Decision

| Question | Verdict |
|---|---|
| Production launch | **No-go** |
| Closed earn pilot with real mainnet funds | **No-go** until I20 B1, B4 and B5 |
| Sandbox partner certification | **Go** — Zest supply quote → SDK validate → `AWAITING_SIGNATURE` only |
| Partner webhooks | **Not certified** |
| Testnet writes | **Stay disabled** |

## Named ownership (K40)

| Role | Owner |
|---|---|
| Product | Kenzman |
| Incident response | IBK |
| Support | Kenzman |
| Reviewer | IBK |

Go-live is refused until these roles are named **and** reachable (on-call / escalation contacts still tracked under I20 B5).

## Rollback triggers

Disable the affected capability first (`pnpm ops:disable` / `ops:pause`), then roll back code only if needed ([rollback runbook](../runbooks/rollback.md)).

1. SEV-0 suspected fund loss or compromised registry
2. SEV-1 wrong plan/risk or cross-tenant exposure
3. Rollback drill failure against the chosen target
4. Operator switch ignored after deploy (pre-I17 target)
5. Signed registry activation fails verification

Minimum rollback target remains **at or after I17 (`3d2d89e`)**.

## Go-live requirements (all blocking)

1. All P0 release gates pass (`pnpm gate:k38`, `pnpm gate:k39`, `pnpm gate:k40`)
2. I20 blockers B1, B4 and B5 resolved for any closed earn pilot with funds
3. Named product, incident and support owners recorded and reachable
4. Manual pilot checks M1–M10 recorded with real wallets
5. Rollback drill passes against the previous release tag

## K40 pilot evidence

| Item | Result |
|---|---|
| Five sandbox pilot entry/exit sessions | Pass — fixture Zest supply to `AWAITING_SIGNATURE`, exit via `USER_REJECTED` (no broadcast) |
| One external partner sandbox integration | Pass — `pnpm partner:example` + `pnpm sdk:compat` |
| Real-wallet M1–M10 | **Not run** — still required before any later go |
| On-chain confirmed exit | **Blocked** — ingestion does not advance past `SUBMITTED` (I20 B1) |

Evidence bundle: `docs/release/evidence/k40-latest.json` / `k40-latest.md`.

## Verified surface vs promised surface

| Action | Network | Certification | Why |
|---|---|---|---|
| Zest supply | mainnet | **sandbox** | Partner program and SDK smoke. Host wallet broadcasts; SDK does not. |
| Zest withdraw | mainnet | not certified | Workflows do not move past `SUBMITTED` (I20 B1). |
| sBTC deposit / withdraw | mainnet | not certified | No product screen; no Bitcoin/Emily ingestion (I20 B2). |
| Granite collateral / borrow / repay | mainnet | not certified | Positions unread; DIA USDC unset (I20 B3). |
| Bitflow swap | mainnet | not certified | Pool principal not pinned (I20 B6). |
| Every testnet write | testnet | disabled | Unverified test environments. |
| Stake | both | disabled | K16 exclusion. |

`packages/sdk/src/launch.test.ts` fails if a disabled capability is certified, or if a sandbox row is not enabled in the registry.

## Commands

```sh
pnpm gate:k40
pnpm partner:example
pnpm sdk:compat
```

## What this does not do

- It does not flip production or closed earn pilot to go.
- It does not publish packages (K39 packs only).
- It does not replace I20 manual checks M1–M10.
