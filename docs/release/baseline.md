# Delivery and release baseline

| | |
|---|---|
| Task | I21 Reset the delivery ledger and release baseline |
| Requirements | Release baseline and evidence ledger |
| Owner / reviewer | IBK / kenzman |
| Depends on | None |
| Feeds | I31 shell and design system; I22 worker topology; I33 BTC screens |
| Baseline commit | `60b21c67e8fa20763f67e9b1d132205a1843f37e` (`origin/main`) |
| Measured | 2026-09-21, Node `v24.21.0`, pnpm `12.4.1` |

Deliverable from the task page: record the current build, test, data and backfill baseline, and make sure every active task has an owner, reviewer, dependency and evidence target.

## Scope and method

The requested baseline commit is `60b21c6`. The working branch was created from local commit `5ad835e`, whose only additional change is to ignore local agent-handoff and wireframe files; it does not change source, tests, packages or release evidence. Commands below were rerun with Node 24 as required. Results are recorded as observed, not inferred from the task page.

## Automated evidence

| Check | Command | Observed result |
|---|---|---|
| Types | `pnpm typecheck` | Pass. `tsc --noEmit` completed for all 24 configured projects, including `apps/api`. |
| Boundaries | `pnpm boundaries` | Pass. Architecture boundaries passed; dependency-cruiser reported no violations across 210 modules and 720 dependencies. |
| Adapter certification | `pnpm adapters:certify` | Pass. Five fixture reports (`sbtc` deposit and withdrawal, Zest earn, Granite credit and Bitflow swap) were `fixture_conformant`. Each covers semantic amounts and units, registry and block evidence, exact read/quote/plan fixtures, signing validation, event decoding, reconciliation matching and fail-closed mismatch handling. |
| Full test suite | `pnpm test` | Pass on the unrestricted `pnpm run ci` rerun: 297 unit tests passed, 1 skipped; 13 fixture tests and 10 check tests passed; SDK checks passed; compatibility ended `19 checks passed. K19: partner surface holds. K20: production no-go; sandbox Zest supply only.` The same command cannot complete in the restricted sandbox because `apps/partner-example/src/program.test.ts` waits for a local `127.0.0.1` demo-server bind. |
| Full gate | `pnpm run ci` | Pass. Lint (with the repository's existing Biome deprecation notice), boundaries, full tests, three production builds, OpenAPI verification and generated error-document verification all completed successfully. |

## Data and pilot state

The six pilot blockers from [the pilot checklist](pilot-checklist.md#pilot-blockers) remain open:

| Blocker | Current evidence |
|---|---|
| B1 | `apps/worker/src/ingest.ts` records each canonical activity with `workflowId: null`. No transaction is linked to its workflow, so workflows do not advance beyond `SUBMITTED`. |
| B2 | The product has no BTC-to-sBTC or sBTC-to-BTC flow, and Bitcoin and Emily are not ingested. |
| B3 | Granite positions cannot be read from the registered contract and the DIA USDC feed is unset; borrow remains safely blocked. |
| B4 | Terms, privacy, risk disclosures and support ownership are absent. |
| B5 | No on-call owner, protocol emergency contacts or alert destination beyond standard output are recorded. |
| B6 | No independent address review is recorded and the Bitflow pool principal is not pinned. |

Manual pilot checks M1 through M10 are all unrecorded and therefore have not been run. The [incident-runbook reproduction record](../runbooks/incidents.md#reproduction-record) is also empty.

## Checked, not reproducible

The task-page request to capture a stale-evidence allocation regression and an API strict-TypeScript failure cannot be satisfied honestly: neither was reproducible at the requested baseline.

- There is no capital-allocation code in the repository. `packages/ui/src/compare.ts` is the only earn ranking path; it refuses ranking for unavailable supply or withdrawal, paused markets, missing rates, stale reads, invalid or future timestamps, and reads older than 300 seconds (which is stricter than 15 minutes).
- `pnpm typecheck` passed, including `apps/api`. The API error envelope in `apps/api/src/errors.ts` conditionally adds `retryAfter` only when supplied, matching the optional schema field; no strict TypeScript failure was observed.

## Active-task ledger

| Task | Owner / reviewer | Dependency | Evidence target |
|---|---|---|---|
| I21 delivery baseline | IBK / kenzman | None | This baseline and a passing `pnpm run ci` |
| I31 shell and design system | IBK / kenzman | I21 | Eight centralized state implementations and tests; `pnpm run ci`; browser tests |
| I22 worker topology | IBK / kenzman | I21 | Four runnable processes, health and restart-idempotency evidence; `pnpm run ci` |
| I33 BTC deposit and withdrawal screens | IBK / kenzman | I31 | Reproducible happy and delayed/reclaim journeys that survive reload; `pnpm run ci`; browser tests |

## Limits

This ledger does not change the production verdict: production and a closed mainnet pilot remain no-go, and the only certified surface is sandbox Zest supply through SDK validation up to `AWAITING_SIGNATURE`. It does not run manual pilot checks, backfill data or repair B1.
