# SDK release compatibility gate

| | |
|---|---|
| Task | K19 SDK release compatibility gate |
| Requirements | SDK-01, PMF-01 |
| Owner / reviewer | kenzman / IBK |
| Depends on | I16 embedded components and partner example, K18 failure injection |
| Date | 2026-09-19 |

Architecture §11 (public SDK surface), §14 (production certification), §21 (release gates). This is a gate, not a publish. Packages stay private workspace packages. `pnpm pack` must still succeed so a later registry publish cannot invent a different surface.

## What this slice certifies

A clean partner app may consume only:

| Package | Role |
|---|---|
| `@stacks-capital/sdk` | Validate unsigned plans. Never broadcasts. |
| `@stacks-capital/client` | HTTP to the Capital API. Publishable client id in the browser. |
| `@stacks-capital/react` | Hooks and cache isolated per network and address. |
| `@stacks-capital/ui` | Widgets and the rules behind them. |
| `@stacks-capital/core`, `@stacks-capital/wallets` | Types and wallet guards those packages re-export. |

Adapters, the engine, the database and fixtures stay off that list. The embed-example boundary rule already fails CI if a partner page imports them.

## Certification items from page 14

| Item | Result |
|---|---|
| Clean Vite/workspace install; no server secret in the browser bundle | Met. `readEmbedConfig` refuses `key_` / `ses_` in any `VITE_` value. |
| Network switching invalidates quotes and plans | Met. Cache keys start with network and address (`sameScope`). Switching network in Everything Stacks drops the wallet session. |
| Review matches the unsigned plan | Met. `toWalletRequest` / `validatePlan`; SDK `submit()` throws `UNSUPPORTED_ACTION`. |
| Earn workflow resumes after reload | Met in I18 browser tests (fake wallet). Real wallets remain I20 manual checks. |
| Webhook HMAC, timestamp tolerance, event-id deduplication | **Not certified.** No partner webhooks exist (I20 N10). K20 records that as out of surface. |
| Envelope compatibility | Met. `schemaVersion` is locked at `1.0` in the API, the client and this gate. Removing a public value export fails the gate. |

Error recovery is part of the same gate: `QUOTE_EXPIRED` / `ORACLE_STALE` are `requote`; `BROADCAST_UNKNOWN` is `investigation` and `allowsWriteRetry` is false (K17, K18).

## Evidence

- `packages/sdk/src/surface.ts` — frozen export names, forbidden partner dependencies, launch rows used by K20
- `packages/sdk/src/surface.test.ts`, `packages/sdk/src/launch.test.ts`
- `pnpm sdk:compat` — the CI gate, including `pnpm pack @stacks-capital/sdk`
- Existing: embed-example boundary, partner-example Zest supply to `AWAITING_SIGNATURE`, `pnpm sdk:check`

## Still owned elsewhere

- Publishing to a registry (I20 N9). This gate proves the tarball can be built; it does not publish.
- Partner webhooks.
- Hosted production deployment.
