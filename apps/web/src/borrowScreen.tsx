import type { QuotedPlan } from "@stacks-capital/client";
import { useCapital, useMarketRisk } from "@stacks-capital/react";
import type { WalletId } from "@stacks-capital/wallets";
import { useState } from "react";
import {
  askWallet,
  type BorrowAction,
  canSign,
  type ConnectedWallet,
  findProvider,
  messageFor,
  Panel,
  panelState,
  projectBorrow,
  QUOTE_ACTION,
  reviewQuote,
  StateNote,
  toWalletRequest,
} from "@stacks-capital/ui";

const MARKET = "granite.sbtc.isolated";
const ACTIONS: { id: BorrowAction; label: string }[] = [
  { id: "collateral_add", label: "Add collateral" },
  { id: "borrow", label: "Borrow" },
  { id: "repay", label: "Repay" },
  { id: "collateral_remove", label: "Withdraw collateral" },
];

const bps = (value: bigint | undefined) => (value === undefined ? "unknown" : `${(Number(value) / 100).toFixed(2)}%`);

export function Borrow({ wallet, signedIn }: { wallet: ConnectedWallet | null; signedIn: boolean }) {
  const { client } = useCapital();
  const risk = useMarketRisk(signedIn ? MARKET : null, { staleMs: 15_000 });
  const [action, setAction] = useState<BorrowAction>("collateral_add");
  const [amount, setAmount] = useState("");
  const [quoted, setQuoted] = useState<QuotedPlan | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Borrow">
        <p className="muted">Connect a wallet and sign in to borrow against collateral.</p>
      </Panel>
    );
  }

  // Wallet balances have no endpoint yet, so the amount is not checked against what is held (I09).
  const projection =
    risk.data === undefined ? null : projectBorrow(risk.data.data, { action, amount, walletBalance: null }, new Date());

  async function submit() {
    if (projection === null || !projection.canProceed) return;
    setBusy(true);
    setProblem(null);
    try {
      const quote = await client.quote({ marketId: MARKET, action: QUOTE_ACTION[action], amount });
      setQuoted(quote.data);
      const view = reviewQuote(quote.data.quote, new Date());
      if (!canSign(view)) throw new Error(view.warnings.join(" ") || "This quote cannot be signed.");

      const started = await client.startWorkflow({
        quoteId: quote.data.quote.id,
        idempotencyKey: `idem_${crypto.randomUUID()}`,
      });
      const step = started.data.plan.steps[0];
      if (step === undefined) throw new Error("The plan has no step to sign");

      const provider = findProvider(wallet?.id as WalletId);
      if (provider === null) throw new Error("The wallet is no longer available");
      const answer = await askWallet(provider, wallet?.id as WalletId, toWalletRequest(step));
      if (answer.kind === "rejected") {
        setProblem(answer.message);
        return;
      }
      const walletResult = answer.result;
      const recorded = await client.recordSignature(started.data.workflowId, { stepId: step.id, walletResult });
      setOutcome(`${recorded.data.state}, next ${recorded.data.nextAction}`);
      await risk.refresh();
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Borrow against collateral">
      <StateNote state={panelState(risk, risk.data?.context)} onRetry={() => void risk.refresh()} />

      <div className="actions">
        {ACTIONS.map((entry) => (
          <button key={entry.id} type="button" aria-pressed={action === entry.id} onClick={() => setAction(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>

      <label>
        Amount in base units
        <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
      </label>

      {projection?.health === null || projection === null ? (
        <p className="muted">Enter an amount to see what it would do to your position.</p>
      ) : (
        <dl className="health">
          <dt>Collateral</dt>
          <dd>{projection.health?.collateralUsd.toString()} USD (8 decimals)</dd>
          <dt>Debt</dt>
          <dd>{projection.health?.debtUsd.toString()} USD (8 decimals)</dd>
          <dt>Loan to value after</dt>
          <dd>{bps(projection.health?.currentLtvBps)}</dd>
          <dt>Liquidation at</dt>
          <dd>{bps(projection.health?.liquidationThresholdBps)}</dd>
          <dt>Most you could borrow</dt>
          <dd>{projection.health?.maxBorrow.toString()}</dd>
        </dl>
      )}

      {(projection?.blockers ?? []).map((blocker) => (
        <p key={blocker} className="error">
          {blocker}
        </p>
      ))}
      {(projection?.notes ?? []).map((note) => (
        <p key={note} className="warn">
          {note}
        </p>
      ))}

      <button
        type="button"
        disabled={busy || projection === null || !projection.canProceed}
        onClick={() => void submit()}
      >
        {ACTIONS.find((entry) => entry.id === action)?.label} in your wallet
      </button>

      {quoted === null ? null : <p className="muted">{quoted.plan.reviewSummary}</p>}
      {outcome === null ? null : <p>Submitted: {outcome}</p>}
      {problem === null ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </Panel>
  );
}
