import type { QuotedPlan } from "@stacks-capital/client";
import { useCapital, usePrices } from "@stacks-capital/react";
import type { WalletId } from "@stacks-capital/wallets";
import { useEffect, useState } from "react";
import type { ConnectedWallet } from "./session.ts";
import { toWalletRequest } from "./signing.ts";
import { messageFor, panelState } from "./state.ts";
import { canApprove, swapView } from "./swap.ts";
import { Panel, StateNote } from "./ui.tsx";
import { findProvider } from "./wallet.ts";

const MARKET = "bitflow.sbtc-usdcx";
const ASSETS = { sentFeed: "BTC/USD", receivedFeed: "USDC/USD", sentDecimals: 8, receivedDecimals: 6 };

export function Swap({ wallet, signedIn }: { wallet: ConnectedWallet | null; signedIn: boolean }) {
  const { client } = useCapital();
  const prices = usePrices({ staleMs: 15_000 });
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState("50");
  const [quoted, setQuoted] = useState<QuotedPlan | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The countdown has to move on its own, or an expired quote would still look valid.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Swap">
        <p className="muted">Connect a wallet and sign in to swap.</p>
      </Panel>
    );
  }

  const view = quoted === null ? null : swapView(quoted, prices.data?.data.items ?? [], ASSETS, now);
  const approvable = view !== null && quoted !== null && canApprove(view, quoted);

  async function refresh() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await client.quote({ marketId: MARKET, action: "swap", amount, slippageBps });
      setQuoted(result.data);
      setNow(new Date());
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (quoted === null || view === null || !canApprove(view, quoted) || wallet === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const started = await client.startWorkflow({
        quoteId: quoted.quote.id,
        idempotencyKey: `idem_${crypto.randomUUID()}`,
      });
      const step = started.data.plan.steps[0];
      if (step === undefined) throw new Error("The plan has no step to sign");
      const provider = findProvider(wallet.id as WalletId);
      if (provider === null) throw new Error("The wallet is no longer available");
      const request = toWalletRequest(step);
      const walletResult = await provider
        .request(request.method, request.params)
        .catch((error: unknown) => ({ error: messageFor(error).message }));
      const recorded = await client.recordSignature(started.data.workflowId, { stepId: step.id, walletResult });
      setOutcome(`${recorded.data.state}, next ${recorded.data.nextAction}`);
      setQuoted(null);
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Swap">
      <StateNote state={panelState(prices, prices.data?.context)} onRetry={() => void prices.refresh()} />

      <label>
        Amount in base units
        <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
      </label>
      <label>
        Slippage in basis points
        <input value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} inputMode="numeric" />
      </label>
      <button type="button" disabled={busy || amount === ""} onClick={() => void refresh()}>
        {quoted === null ? "Get a quote" : "Refresh the quote"}
      </button>

      {view === null ? null : (
        <div className="quote">
          <h3>Route</h3>
          <ol>
            {view.route.map((leg) => (
              <li key={`${leg.contractId}:${leg.functionName}`}>
                {leg.contractId} calling {leg.functionName}
              </li>
            ))}
          </ol>

          <dl>
            <dt>Sending</dt>
            <dd>{view.sending}</dd>
            <dt>Expected</dt>
            <dd>{view.expectedReceived}</dd>
            <dt>At least</dt>
            <dd>{view.minimumReceived ?? "no floor in this quote"}</dd>
            <dt>Price impact</dt>
            <dd>{view.impactBps === null ? "unknown" : `${(Number(view.impactBps) / 100).toFixed(2)}%`}</dd>
          </dl>

          {view.impactNote === null ? null : <p className="warn">{view.impactNote}</p>}
          {view.warnings.map((warning) => (
            <p key={warning} className="warn">
              {warning}
            </p>
          ))}

          <p className={view.expired || view.needsRefresh ? "error" : "muted"}>
            {view.expired
              ? "This quote has expired. Refresh before approving."
              : view.needsRefresh
                ? `Only ${view.expiresInSeconds}s left. Refresh before approving.`
                : `Valid for ${view.expiresInSeconds}s.`}
          </p>

          <button type="button" disabled={busy || !approvable} onClick={() => void approve()}>
            Approve in your wallet
          </button>
        </div>
      )}

      {outcome === null ? null : <p>Submitted: {outcome}</p>}
      {problem === null ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </Panel>
  );
}
