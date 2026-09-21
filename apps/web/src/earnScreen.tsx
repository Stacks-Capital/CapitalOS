import type { QuotedPlan, StartedWorkflow } from "@stacks-capital/client";
import { useCapital, useWorkflow } from "@stacks-capital/react";
import { createCapitalOS, parsePlan, parseQuote, type PlanWire, type QuoteWire } from "@stacks-capital/sdk";
import { useEffect, useMemo, useState } from "react";
import type { WalletId } from "@stacks-capital/wallets";
import {
  askWallet,
  attemptTxid,
  canSign,
  clearPending,
  contractOf,
  EarnComparison,
  EmptyStateView,
  explorerTxUrl,
  FailedDelayedStateView,
  type ConnectedWallet,
  findProvider,
  loadPending,
  messageFor,
  Panel,
  reviewQuote,
  ReviewStateView,
  savePending,
  StaleDisputedStateView,
  stageFor,
  SubmittedStateView,
  toWalletRequest,
} from "@stacks-capital/ui";

const idempotencyKey = () => `idem_${crypto.randomUUID()}`;
const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

function sdkValidation(plan: QuotedPlan["plan"], quote: QuotedPlan["quote"], sender: string) {
  const os = createCapitalOS({ network: plan.network });
  return os.validate(parsePlan(plan as PlanWire), parseQuote(quote as QuoteWire), { sender });
}

export function Earn({ wallet, signedIn }: { wallet: ConnectedWallet | null; signedIn: boolean }) {
  const { client } = useCapital();
  const [marketId, setMarketId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [quoted, setQuoted] = useState<QuotedPlan | null>(null);
  const [started, setStarted] = useState<StartedWorkflow | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const network = wallet?.network ?? null;
  const address = wallet?.address ?? null;
  const scope = useMemo(() => (network === null || address === null ? null : { network, address }), [network, address]);
  const pending = useMemo(() => (scope === null ? null : loadPending(storage(), scope)), [scope]);
  const workflowId = started?.workflowId ?? pending?.workflowId ?? null;
  const workflow = useWorkflow(workflowId, { staleMs: 5_000 });
  const stage = stageFor(workflow.data?.data.state ?? (started === null ? null : started.state));
  const workflowState = workflow.data?.data.state ?? started?.state ?? "unknown";
  const txid = attemptTxid(workflow.data?.data.attempts ?? []);

  // A finished flow is not pending any more, so a reload starts fresh.
  useEffect(() => {
    if (scope !== null && (stage === "done" || stage === "recovery")) clearPending(storage(), scope);
  }, [scope, stage]);

  async function getQuote() {
    if (marketId === null || wallet === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await client.quote({ marketId, action: "supply", amount, owner: wallet.address });
      setQuoted(result.data);
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  // Asks the wallet for one step. A rejection leaves the workflow waiting, so the user can simply try again.
  async function requestSignature(start: StartedWorkflow, quote: QuotedPlan["quote"]) {
    if (wallet === null) return;
    const step = start.plan.steps[0];
    if (step === undefined) throw new Error("The plan has no step to sign");
    const provider = findProvider(wallet.id as WalletId);
    if (provider === null) throw new Error(`${wallet.id} is not available any more`);

    const validation = sdkValidation(start.plan, quote, wallet.address);
    const answer = await askWallet(provider, wallet.id as WalletId, toWalletRequest(step, validation), validation);
    if (answer.kind === "rejected") {
      setProblem(answer.message);
      return;
    }
    // Whatever else the wallet said is sent as it is. The server decides what it means.
    await client.recordSignature(start.workflowId, { stepId: step.id, walletResult: answer.result });
    await workflow.refresh();
  }

  async function signAndSubmit() {
    if (quoted === null || wallet === null || scope === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const start = await client.startWorkflow({ quoteId: quoted.quote.id, idempotencyKey: idempotencyKey() });
      setStarted(start.data);
      const step = start.data.plan.steps[0];
      if (step === undefined) throw new Error("The plan has no step to sign");
      savePending(storage(), scope, { workflowId: start.data.workflowId, stepId: step.id });
      await requestSignature(start.data, quoted.quote);
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function askAgain() {
    if (started === null || quoted === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await requestSignature(started, quoted.quote);
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  if (wallet === null || !signedIn) {
    return (
      <Panel title="Earn">
        <EmptyStateView
          state={{ kind: "empty", instruction: "Connect a wallet and sign in to supply into a vault." }}
        />
      </Panel>
    );
  }

  const view = quoted === null ? null : reviewQuote(quoted.quote, new Date());

  return (
    <>
      {pending !== null && started === null ? (
        <Panel title="Unfinished step">
          <p>
            A step from earlier is still open: <strong>{pending.workflowId}</strong>. It is shown below as it stands
            now.
          </p>
        </Panel>
      ) : null}

      {stage === "review" ? (
        <Panel title="Compare and review">
          <EarnComparison onChoose={setMarketId} selectedMarketId={marketId} />

          <p className="muted">Fees depend on the amount, and are shown with the quote below.</p>
          <label>
            Amount in base units
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
          </label>
          <button type="button" disabled={busy || marketId === null || amount === ""} onClick={() => void getQuote()}>
            Get a quote
          </button>

          {view === null || quoted === null ? null : (
            <div className="quote">
              <p className={view.expired ? "error" : "muted"}>
                {view.expired ? "This quote has expired. Ask for a new one." : `Valid for ${view.expiresInSeconds}s.`}
              </p>
              {/* An expired or disputed quote is the stale state, and it cannot be signed from. */}
              {view.expired ? (
                <StaleDisputedStateView
                  state={{
                    kind: "stale_disputed",
                    ageDescription: "past its expiry",
                    sources: quoted.quote.snapshots.length > 0 ? quoted.quote.snapshots : [quoted.quote.marketId],
                    onRequote: () => void getQuote(),
                  }}
                />
              ) : (
                <ReviewStateView
                  state={{
                    kind: "review",
                    giveAmount: view.input,
                    receiveAmount: view.expected,
                    fees: view.fees,
                    ...(view.minimumOutput === null ? {} : { minimumOutput: view.minimumOutput }),
                    protocol: quoted.quote.marketId,
                    contract: contractOf(quoted.plan.steps),
                    planValidated: canSign(view) && !busy,
                    ...(canSign(view)
                      ? {}
                      : { validationError: view.warnings.join(" ") || "This quote cannot be signed." }),
                    onConfirm: () => void signAndSubmit(),
                  }}
                />
              )}
              {view.warnings.length > 0 ? <p className="warn">{view.warnings.join(" ")}</p> : null}
              <p className="muted">{quoted.plan.reviewSummary}</p>
            </div>
          )}
        </Panel>
      ) : null}

      {stage === "signing" ? (
        <Panel title="Waiting for your wallet">
          <p>Approve the transaction in {wallet.id}. Nothing moves until you do.</p>
          {started === null ? null : (
            <button type="button" disabled={busy} onClick={() => void askAgain()}>
              Ask the wallet again
            </button>
          )}
        </Panel>
      ) : null}

      {stage === "confirming" ? (
        <Panel
          title="Confirming"
          action={
            <button type="button" onClick={() => void workflow.refresh()}>
              Check
            </button>
          }
        >
          {txid === null ? (
            <p>
              Submitted. State: <strong>{workflowState}</strong>. Next:{" "}
              {workflow.data?.data.nextAction ?? started?.nextAction}
            </p>
          ) : (
            <SubmittedStateView
              state={{
                kind: "submitted",
                txId: txid,
                explorerUrl: explorerTxUrl(txid, wallet.network),
                workflowState,
                nextAction: workflow.data?.data.nextAction ?? started?.nextAction ?? "Wait for confirmation.",
              }}
            />
          )}
        </Panel>
      ) : null}

      {stage === "recovery" ? (
        <Panel title="Needs a look">
          <FailedDelayedStateView
            state={{
              kind: "failed_delayed",
              cause:
                "The wallet did not return a transaction id, or the workflow needs attention. Nothing is retried automatically, because that could move your money twice.",
              fundsLocation:
                txid === null
                  ? `Whether anything was broadcast is unknown, so this workflow is being investigated rather than sent again. State ${workflowState}, workflow ${workflowId}.`
                  : `A transaction was broadcast as ${txid}. State ${workflowState}, workflow ${workflowId}.`,
              recovery: [
                {
                  type: "support",
                  label: "Copy workflow id",
                  action: () => void navigator.clipboard?.writeText(workflowId ?? ""),
                },
              ],
            }}
          />
        </Panel>
      ) : null}

      {stage === "done" ? (
        <Panel title="Done">
          <p>The supply completed. Workflow {workflowId}.</p>
        </Panel>
      ) : null}

      {problem === null ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}
