# Delivery and release baseline

| | |
|---|---|
| Task | I21 Reset the delivery ledger and release baseline |
| Requirements | None named on the task page |
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
| Unit, fixture and check suites | `pnpm test` | Pass. 297 of 298 unit tests passed with 1 skipped; 13 fixture tests and 10 check tests passed; SDK checks passed. Compatibility ended `19 checks passed. K19: partner surface holds. K20: production no-go; sandbox Zest supply only.` |
| Full gate | `pnpm run ci` | Pass, exit 0. Lint, boundaries, the full test suite, three production builds, OpenAPI verification and generated error-document verification all completed. Lint passes with one pre-existing deprecation notice: `biome.json` line 18 uses Biome's deprecated `recommended` field, which its next major version removes. |
| Integration against Postgres | `pnpm test:integration` | Not rerun for this baseline; it needs a live database. The last recorded result is 89 of 89 in the [pilot checklist](pilot-checklist.md). |
| Browser journeys and accessibility | `pnpm test:browser` | Not rerun for this baseline. The last recorded result is 18 of 18, desktop and mobile Chromium, in the [pilot checklist](pilot-checklist.md). |

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

- There is no capital-allocation code in the repository. `packages/ui/src/compare.ts` is the only earn ranking path; it refuses ranking for unavailable supply or withdrawal, paused markets, missing rates, stale reads, invalid or future timestamps, and reads older than `EARN_OPTION_MAX_AGE_MS`, which is 300 seconds. That limit was 15 minutes until PR #16 tightened it, so the 301-second boundary the task page asks about is already enforced on the only ranking path that exists.
- `pnpm typecheck` passed, including `apps/api`. The API error envelope in `apps/api/src/errors.ts` conditionally adds `retryAfter` only when supplied, matching the optional schema field; no strict TypeScript failure was observed.

## Active-task ledger

These four are the tasks that can be worked now. The stated dependency is the one on the task page; where this baseline treats it differently, the reason is recorded rather than the dependency being dropped.

| Task | Owner / reviewer | Stated dependency | Treated as | Evidence target |
|---|---|---|---|---|
| I21 delivery baseline | IBK / kenzman | None | Same | This baseline and a passing `pnpm run ci` |
| I31 shell and design system | IBK / kenzman | I30 | Ready now. I30's deliverables, the hooks and embeddable components, already exist in `packages/react` and `packages/ui` from I08 and I16, so nothing in I31 waits on new work | Eight centralized state implementations and tests; `pnpm run ci`; browser tests |
| I22 worker topology | IBK / kenzman | I21, K21 | I21 only. K21 asks for two defects to be fixed that are not reproducible here, see [Checked, not reproducible](#checked-not-reproducible). Nothing in I22 depends on that fix. **This reclassification is not agreed with the K-task owner and is open.** | Four runnable processes, health and restart-idempotency evidence; `pnpm run ci` |
| I33 BTC deposit and withdrawal screens | IBK / kenzman | I31, K25, K26 | Same. K25 and K26 landed in PR #16, with an integration note for this task at `docs/engineering/sbtc-withdrawal.md` | Reproducible happy and delayed/reclaim journeys that survive reload; `pnpm run ci`; browser tests |

The remaining tasks in the tranche, I23 to I30, I32 and I34 to I40, each wait on a K task that has not landed or on one of the four above. I23 and I24 become ready as soon as I22 lands, because K23 and K24 arrived in PR #16.

## Not done: reclassifying existing tasks

The task page also asks for unsupported Done tasks to be reclassified to their evidenced state. That half is not done, and it is blocked rather than skipped.

Every task in I01 to I20 and K01 to K20 has a merged pull request and a document under `docs/` recording its evidence. Which of them count as Done without acceptance evidence is a judgement this baseline cannot make alone, and half the list belongs to the other engineer. The K-task owner needs to name the specific tasks and say what is missing from each.

Two evidence gaps are already known and are not a matter of judgement:

- The reproduction record at the end of [the incident runbook](../runbooks/incidents.md#reproduction-record) is empty. By design it needs a second engineer to follow the quickstart on a clean machine; the author of the work cannot fill it.
- Manual pilot checks M1 to M10 in [the pilot checklist](pilot-checklist.md) have never been run. They need real wallets and small mainnet amounts.

Until those two are filled, I19 and I20 are the tasks whose evidence is genuinely incomplete.

## Limits

This ledger does not change the production verdict: production and a closed mainnet pilot remain no-go, and the only certified surface is sandbox Zest supply through SDK validation up to `AWAITING_SIGNATURE`. It does not run manual pilot checks, backfill data or repair B1.
