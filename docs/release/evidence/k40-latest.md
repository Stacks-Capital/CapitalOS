# K40 gate evidence

| | |
|---|---|
| Generated | 2026-09-22T16:17:59.981Z |
| Production | **no-go** |
| Closed earn pilot | **no-go** |
| Sandbox certification | **go** |
| Result | **PASS** |

## Ownership

| Role | Owner |
|---|---|
| Product | Kenzman |
| Incident | IBK |
| Support | Kenzman |
| Reviewer | IBK |

## Pilot sessions

| Pilot | Entry | Exit | Workflow |
|---|---|---|---|
| pilot-01 | AWAITING_SIGNATURE | USER_REJECTED | wf_pilot-01 |
| pilot-02 | AWAITING_SIGNATURE | USER_REJECTED | wf_pilot-02 |
| pilot-03 | AWAITING_SIGNATURE | USER_REJECTED | wf_pilot-03 |
| pilot-04 | AWAITING_SIGNATURE | USER_REJECTED | wf_pilot-04 |
| pilot-05 | AWAITING_SIGNATURE | USER_REJECTED | wf_pilot-05 |

## Checks

| Category | ID | Result | Detail |
|---|---|---|---|
| ownership | named-owners | pass | product=Kenzman; incident=IBK; support=Kenzman |
| ownership | rollback-triggers | pass | 5 triggers |
| decision | production-no-go | pass | no-go |
| decision | closed-earn-pilot-no-go | pass | no-go |
| decision | sandbox-cert-go | pass | go |
| decision | go-live-requirements | pass | K38,K39,K40 |
| pilot | pilot:pilot-01 | pass | AWAITING_SIGNATURE → USER_REJECTED (wf_pilot-01) |
| pilot | pilot:pilot-02 | pass | AWAITING_SIGNATURE → USER_REJECTED (wf_pilot-02) |
| pilot | pilot:pilot-03 | pass | AWAITING_SIGNATURE → USER_REJECTED (wf_pilot-03) |
| pilot | pilot:pilot-04 | pass | AWAITING_SIGNATURE → USER_REJECTED (wf_pilot-04) |
| pilot | pilot:pilot-05 | pass | AWAITING_SIGNATURE → USER_REJECTED (wf_pilot-05) |
| pilot | pilot:five-sessions | pass | 5/5 |
| partner | partner:example | pass | pass |
| partner | sdk:compat | pass | pass |
| partner | launch-tests | pass | pass |
| gates | evidence:k38 | pass | prior evidence pass |
| gates | evidence:k39 | pass | prior evidence pass |
| decision | launch-decision-doc | pass | /home/modev/Stacks Ecosystem/CapitalOS/docs/release/launch-decision.md |

## Rollback triggers

- SEV-0 suspected fund loss or compromised registry
- SEV-1 wrong plan/risk or cross-tenant exposure
- Rollback drill failure against the chosen target
- Operator switch ignored after deploy (pre-I17 target)
- Signed registry activation fails verification

## Go-live requirements (all still blocking production)

- All P0 release gates pass (K38 matrices, K39 RC pack, K40 pilot evidence)
- I20 blockers B1, B4 and B5 resolved for any closed earn pilot with funds
- Named product, incident and support owners recorded and reachable
- Manual pilot checks M1–M10 recorded with real wallets
- Rollback drill passes against the previous release tag

## Limitations

- Production and closed earn pilot remain no-go.
- Five pilot sessions are fixture sandbox entry→reject exit; real-wallet M1–M10 remain unrun.
- On-chain confirmed exit is blocked until ingestion links txs past SUBMITTED (I20-B1).
- Partner certification is the in-repo partner-example + sdk:compat path (packages still private).
- Go-live still requires B4/B5 disclosures and reachable on-call contacts outside this gate.

## Commands

```sh
pnpm gate:k40
pnpm partner:example
```
