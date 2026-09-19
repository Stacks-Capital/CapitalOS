import type { QuotedPlan, StartedWorkflow } from "@stacks-capital/client";
import { useCapital, useWorkflow } from "@stacks-capital/react";
import { useEffect, useMemo, useState } from "react";
import type { WalletId } from "@stacks-capital/wallets";
import {
  askWallet,
  canSign,
  clearPending,
  EarnComparison,
  type ConnectedWallet,
  findProvider,
  loadPending,
  messageFor,
  Panel,
  reviewQuote,
  savePending,
  stageFor,
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
  async function requestSignature(start: StartedWorkflow) {
    if (wallet === null) return;
    const step = start.plan.steps[0];
    if (step === undefined) throw new Error("The plan has no step to sign");
    const provider = findProvider(wallet.id as WalletId);
    if (provider === null) throw new Error(`${wallet.id} is not available any more`);

    const answer = await askWallet(provider, wallet.id as WalletId, toWalletRequest(step));
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
      await requestSignature(start.data);
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function askAgain() {
    if (started === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await requestSignature(started);
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  if (wallet === null || !signedIn) {
    return (
      <Panel title="Earn">
        <p className="muted">Connect a wallet and sign in to supply into a vault.</p>
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

          {view === null ? null : (
            <div className="quote">
              <p>
                You supply {view.input}, expecting {view.expected}.
              </p>
              <ul>
                {view.fees.map((fee) => (
                  <li key={fee.kind}>
                    {fee.kind} fee: {fee.amount}
                  </li>
                ))}
              </ul>
              {view.minimumOutput === null ? null : <p>At least {view.minimumOutput}.</p>}
              {view.warnings.length > 0 ? <p className="warn">{view.warnings.join(" ")}</p> : null}
              <p className={view.expired ? "error" : "muted"}>
                {view.expired ? "This quote has expired. Ask for a new one." : `Valid for ${view.expiresInSeconds}s.`}
              </p>
              <p className="muted">{quoted?.plan.reviewSummary}</p>
              <button type="button" disabled={busy || !canSign(view)} onClick={() => void signAndSubmit()}>
                Sign in your wallet
              </button>
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
          <p>
            Submitted. State: <strong>{workflow.data?.data.state ?? started?.state}</strong>.
          </p>
          <p className="muted">Next: {workflow.data?.data.nextAction ?? started?.nextAction}</p>
        </Panel>
      ) : null}

      {stage === "recovery" ? (
        <Panel title="Needs a look">
          <p className="warn">
            The wallet did not return a transaction id, or the workflow needs attention. Nothing is retried
            automatically, because that could move your money twice.
          </p>
          <p className="muted">
            State: {workflow.data?.data.state ?? "unknown"}. Next: {workflow.data?.data.nextAction ?? "CONTACT_SUPPORT"}
            . Workflow {workflowId}.
          </p>
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
