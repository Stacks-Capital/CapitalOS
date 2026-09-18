# Product end to end and accessibility tests

| | |
|---|---|
| Task | I18 Product end to end and accessibility tests |
| Requirements | SBTC-01, SBTC-02, EARN-01, BOR-01, SWP-01, POS-01, SEC-01 |
| Owner / reviewer | IBK / kenzman |
| Depends on | I15 risk and activity, I17 operations |
| Date | 2026-09-18 |

Deliverable from the task page: cover wallet changes, reloads, rejection, keyboard and mobile, and successful round trips; link automated evidence.

## What runs

`apps/e2e` drives the real web app in Chromium with Playwright. Nothing is mocked between the browser and the database:

| Piece | In the tests |
|---|---|
| Web app | `apps/web`, served by Vite in `e2e` mode on `localhost:5173`, the fixture app's allowed origin |
| API | The real `createApp` on a fresh, seeded `e2e` schema. Market reads come from fixtures, so no test touches a live provider. Rate limits are counted in memory, so no Redis |
| Wallet | A stand in for Leather at `window.LeatherProvider`, answering the way the real wallet did in I02. It signs with a real key in the test process, so the API verifies a genuine signature |

The fake wallet can approve, reject with Leather's `4001`, hang, or answer without a transaction id, and can switch to a different account. Real wallets remain a manual check in the pilot (I20).

Every test runs twice, on a desktop viewport and on a Pixel 7.

## Coverage

| Journey | Checks | Requirements |
|---|---|---|
| Successful round trip | Connect, sign in with a verified signature, compare, quote, sign, reach `SUBMITTED` | EARN-01, SEC-01 |
| Rejection | A rejected transaction sends nothing, the workflow keeps waiting, and asking again completes it | EARN-01, SEC-01 |
| Unknown broadcast | A wallet answer without a transaction id goes to recovery, never an automatic retry | EARN-01 |
| Reload | A reload mid signature comes back to the same step after signing in again | EARN-01, POS-01 |
| Wallet change | A different account never sees the first account's unfinished step | SEC-01, POS-01 |
| Sign in rejected | The user stays signed out and sees one clear reason | SEC-01 |
| Disconnect | The session is forgotten | SEC-01 |
| Accessibility | Every screen passes axe (WCAG 2 A and AA) with no serious or critical issues | all screens |
| Keyboard | The app is reachable and operable from the keyboard alone, with visible focus | all screens |
| Mobile | No screen scrolls sideways on a phone | all screens |

sBTC deposit and withdrawal (SBTC-01, SBTC-02) have no screens yet, so they are covered by the adapter and API tests rather than here. Borrow (BOR-01) and swap (SWP-01) screens are covered by the accessibility, keyboard and mobile checks, and their rules by unit tests; their full signing journeys are blocked by unreadable Granite positions and the unset USDC price (see docs/engineering/borrow.md and swap.md).

## Evidence

- Locally: `pnpm test:browser` (needs the Compose Postgres running). The HTML report lands in `apps/e2e/playwright-report`, results in `apps/e2e/test-results/results.json`.
- In CI: the `End to end and accessibility tests` step runs after the integration tests, and the `e2e-evidence` artifact keeps the report, results, traces and failure screenshots for 30 days. That artifact is the automated evidence the task asks for.

Last local run: 18 passed, 2 skipped by design (keyboard runs on desktop only, the width check on mobile only).

## Bugs these tests found

Each was invisible to the Node and jsdom tests and would have reached a real user.

1. **Every API call failed in a real browser.** The client stored `globalThis.fetch` and called it as a method of another object. Node allows that; browsers throw "Illegal invocation". Fixed in `packages/client`, with a unit test that reproduces the browser's rule and fails on the old code.
2. **Rejecting a transaction sent the user to support.** The screens recorded a wallet rejection as the wallet's answer, which the API files as `BROADCAST_UNKNOWN`. A rejection now leaves the workflow waiting, with "Ask the wallet again". A shared `askWallet` in `packages/ui` sorts answers into answered, rejected and unknown.
3. **The screen stayed on "waiting" after a successful signature.** `refresh` from a render before the workflow existed refreshed nothing. The hook's `refresh` now always acts on the current key, with a regression test that fails on the old code.
4. **A misleading "not allowed" alert after a rejected sign in.** The portfolio asked for positions as soon as a wallet was connected, before sign in. It now waits for a session.
5. **Buttons were unreachable on a phone.** Long asset ids could not wrap, so table cells overlapped the "Choose" button. Long ids now wrap and wide tables scroll inside their panel.

## Configuration

- `apps/web/.env.e2e` points the app at the test API. Vite ranks a mode file above `.env.local`, so a developer's own settings never leak into the tests. It holds publishable values only and is committed (`.gitignore` excepts it).
- The e2e API uses `DATABASE_URL` and drops and recreates its own `e2e` schema on every run.

## Unsupported and deferred

- Chromium only. Firefox and WebKit can be added as Playwright projects when needed.
- Real wallet extensions cannot run in automated tests. They are checked by hand in the pilot.
- Accessibility is scanned by axe, which finds a large share of issues but not all. A manual screen reader pass belongs in the pilot checklist.
