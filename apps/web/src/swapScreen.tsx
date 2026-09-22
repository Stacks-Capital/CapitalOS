import type { QuotedPlan } from "@stacks-capital/client";
import { useCapital, usePrices } from "@stacks-capital/react";
import {
  createStacksCapital,
  parsePlan,
  parseQuote,
  type PlanWire,
  type QuoteWire,
  type StacksNetwork,
} from "@stacks-capital/sdk";
import type { WalletId } from "@stacks-capital/wallets";
import { useEffect, useState } from "react";
import {
  askWallet,
  canApprove,
  type ConnectedWallet,
  contractOf,
  EmptyStateView,
  explorerTxUrl,
  FailedDelayedStateView,
  findProvider,
  messageFor,
  Panel,
  panelState,
  ReviewStateView,
  StaleDisputedStateView,
  StateNote,
  SubmittedStateView,
  swapView,
  toWalletRequest,
} from "@stacks-capital/ui";
import {
  CANONICAL_SWAP_ASSETS,
  formatExpiryCountdown,
  fromBaseUnits,
  isQuoteSignable,
  priceImpactCategory,
  reconcileSwapAssets,
  toBaseUnits,
  verifyMinimumOutputEnforcement,
} from "./swapState.ts";

const MARKET_ID = "bitflow.sbtc-usdcx";

type Direction = "sbtc_to_usdcx" | "usdcx_to_sbtc";

type SubmissionOutcome = {
  workflowId: string;
  state: string;
  nextAction: string;
  txid: string | null;
  network: StacksNetwork;
};

export function Swap({ wallet, signedIn }: { wallet: ConnectedWallet | null; signedIn: boolean }) {
  const { client } = useCapital();
  const prices = usePrices({ staleMs: 15_000 });

  const [direction, setDirection] = useState<Direction>("sbtc_to_usdcx");
  const [displayAmount, setDisplayAmount] = useState<string>("0.01");
  const [slippageBps, setSlippageBps] = useState<string>("50");
  const [customSlippage, setCustomSlippage] = useState<boolean>(false);
  const [quoted, setQuoted] = useState<QuotedPlan | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());
  const [submission, setSubmission] = useState<SubmissionOutcome | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [problem, setProblem] = useState<string | null>(null);

  const network: StacksNetwork = (wallet?.network as StacksNetwork) || "mainnet";
  const storageKey = wallet ? `stacks_capital_swap_workflow_${network}_${wallet.address}` : null;

  // Restore pending workflow on mount or wallet change
  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as SubmissionOutcome;
        if (parsed.workflowId) {
          setSubmission(parsed);
        }
      }
    } catch {
      // Ignore storage read failures
    }
  }, [storageKey]);

  // Persist submission state updates
  useEffect(() => {
    if (!storageKey) return;
    if (submission) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(submission));
      } catch {
        // Ignore storage write failures
      }
    }
  }, [storageKey, submission]);

  // Real-time quote expiry clock
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const inputAsset = direction === "sbtc_to_usdcx" ? CANONICAL_SWAP_ASSETS.sbtc : CANONICAL_SWAP_ASSETS.usdcx;
  const outputAsset = direction === "sbtc_to_usdcx" ? CANONICAL_SWAP_ASSETS.usdcx : CANONICAL_SWAP_ASSETS.sbtc;

  // Decimal conversion
  let baseAmount = "0";
  let inputFormatError: string | null = null;
  try {
    baseAmount = toBaseUnits(displayAmount, inputAsset.decimals);
  } catch (err) {
    inputFormatError = err instanceof Error ? err.message : "Invalid number";
  }

  const assetContext = {
    sentFeed: inputAsset.feedKey,
    receivedFeed: outputAsset.feedKey,
    sentDecimals: inputAsset.decimals,
    receivedDecimals: outputAsset.decimals,
  };

  const view = quoted === null ? null : swapView(quoted, prices.data?.data.items ?? [], assetContext, now);

  // Asset & Onchain enforcement validations
  const assetReconciliation = quoted ? reconcileSwapAssets(quoted.quote as QuoteWire, network) : null;
  const minimumOutputEnforcement =
    quoted && quoted.plan ? verifyMinimumOutputEnforcement(quoted.quote as QuoteWire, quoted.plan as PlanWire) : null;

  // Strict signability gate (AE1, AE2, AE3)
  const isSignable =
    view !== null &&
    quoted !== null &&
    canApprove(view, quoted) &&
    isQuoteSignable(view, quoted, now) &&
    assetReconciliation?.reconciled === true &&
    minimumOutputEnforcement?.enforced === true;

  const expiryState = view ? formatExpiryCountdown(view.expiresInSeconds) : null;
  const impactTier = view ? priceImpactCategory(view.impactBps) : "unknown";

  function handleDirectionToggle() {
    setDirection((prev) => (prev === "sbtc_to_usdcx" ? "usdcx_to_sbtc" : "sbtc_to_usdcx"));
    setDisplayAmount(direction === "sbtc_to_usdcx" ? "700" : "0.01");
    setQuoted(null);
    setProblem(null);
  }

  async function handleRefreshQuote() {
    if (baseAmount === "0" || inputFormatError !== null) return;
    setBusy(true);
    setProblem(null);

    try {
      const slippageNum = Number.parseInt(slippageBps, 10);
      if (Number.isNaN(slippageNum) || slippageNum < 0 || slippageNum > 300) {
        throw new Error("Slippage must be between 0 and 300 basis points (3.0%).");
      }

      const result = await client.quote({
        marketId: MARKET_ID,
        action: "swap",
        amount: baseAmount,
        slippageBps,
        ...(wallet ? { owner: wallet.address } : {}),
      });

      setQuoted(result.data);
      setNow(new Date());
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!isSignable || quoted === null || wallet === null) return;

    setBusy(true);
    setProblem(null);

    try {
      // Re-verify expiry right before initiation
      if (new Date(quoted.quote.expiresAt).getTime() <= Date.now()) {
        throw new Error("Quote expired right before signing. Please request a fresh quote.");
      }

      const started = await client.startWorkflow({
        quoteId: quoted.quote.id,
        idempotencyKey: `idem_${crypto.randomUUID()}`,
      });

      const step = started.data.plan.steps[0];
      if (step === undefined) {
        throw new Error("The plan contains no step to sign.");
      }

      const provider = findProvider(wallet.id as WalletId);
      if (provider === null) {
        throw new Error("The connected wallet provider is unavailable.");
      }

      const os = createStacksCapital({ network: started.data.plan.network });
      const validation = os.validate(parsePlan(started.data.plan as PlanWire), parseQuote(quoted.quote as QuoteWire), {
        sender: wallet.address,
      });

      const answer = await askWallet(provider, wallet.id as WalletId, toWalletRequest(step, validation), validation);

      if (answer.kind === "rejected") {
        setProblem(answer.message);
        return;
      }

      const recorded = await client.recordSignature(started.data.workflowId, {
        stepId: step.id,
        walletResult: answer.result,
      });

      const newSubmission: SubmissionOutcome = {
        workflowId: started.data.workflowId,
        state: recorded.data.state,
        nextAction: recorded.data.nextAction,
        txid: recorded.data.txid,
        network,
      };

      setSubmission(newSubmission);
      setQuoted(null);
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleDismissWorkflow() {
    setSubmission(null);
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Ignore storage removal errors
      }
    }
  }

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Swap">
        <EmptyStateView state={{ kind: "empty", instruction: "Connect a wallet and sign in to swap." }} />
      </Panel>
    );
  }

  return (
    <Panel title="Swap & Route Review">
      <StateNote state={panelState(prices, prices.data?.context)} onRetry={() => void prices.refresh()} />

      {/* Active Submission / Recovery Banner */}
      {submission !== null && (
        <div className="swap-submission-container">
          {submission.txid === null ? (
            <FailedDelayedStateView
              state={{
                kind: "failed_delayed",
                cause:
                  "The wallet did not return a transaction ID, or the broadcast state is unconfirmed. Nothing is retried automatically.",
                fundsLocation: `Whether anything was broadcast is unknown. Workflow state: ${submission.state}, ID: ${submission.workflowId}.`,
                recovery: [
                  {
                    type: "support",
                    label: "Copy workflow ID",
                    action: () => void navigator.clipboard?.writeText(submission.workflowId),
                  },
                ],
              }}
            />
          ) : (
            <SubmittedStateView
              state={{
                kind: "submitted",
                txId: submission.txid,
                explorerUrl: explorerTxUrl(submission.txid, submission.network),
                workflowState: submission.state,
                nextAction: submission.nextAction,
              }}
            />
          )}
          <button type="button" className="btn-secondary dismiss-btn" onClick={handleDismissWorkflow}>
            Start New Swap
          </button>
        </div>
      )}

      {/* Main Swap Form */}
      <div className="swap-card">
        {/* Direction Switcher */}
        <div className="swap-direction-bar">
          <div className="direction-label">
            <span className="asset-tag">{inputAsset.symbol}</span>
            <span className="direction-arrow">→</span>
            <span className="asset-tag">{outputAsset.symbol}</span>
          </div>
          <button
            type="button"
            className="swap-switch-btn"
            onClick={handleDirectionToggle}
            aria-label="Switch swap direction"
          >
            ⇄ Switch Direction
          </button>
        </div>

        {/* Input Amount */}
        <div className="swap-input-group">
          <label htmlFor="swap-amount-input" className="swap-label">
            You Pay ({inputAsset.symbol})
          </label>
          <div className="swap-input-row">
            <input
              id="swap-amount-input"
              className="swap-amount-input"
              value={displayAmount}
              onChange={(e) => {
                setDisplayAmount(e.target.value);
                setQuoted(null);
                setProblem(null);
              }}
              placeholder={`0.0 ${inputAsset.symbol}`}
              inputMode="decimal"
              disabled={busy}
            />
            <span className="swap-unit-badge">{inputAsset.symbol}</span>
          </div>
          <div className="swap-base-units-hint">
            {inputFormatError ? (
              <span className="error-hint">{inputFormatError}</span>
            ) : (
              <span>
                Exact: <code>{baseAmount}</code> base units ({inputAsset.decimals} decimals)
              </span>
            )}
          </div>
        </div>

        {/* Slippage Selector */}
        <div className="slippage-control-group">
          <div className="slippage-label-row">
            <span className="swap-label">Max Slippage Tolerance</span>
            <span className="slippage-current-value">
              {(Number.parseInt(slippageBps, 10) / 100).toFixed(2)}% ({slippageBps} bps)
            </span>
          </div>
          <div className="slippage-toggle-group">
            {[
              { label: "0.1%", bps: "10" },
              { label: "0.5%", bps: "50" },
              { label: "1.0%", bps: "100" },
            ].map((preset) => (
              <button
                key={preset.bps}
                type="button"
                className={`slippage-btn ${slippageBps === preset.bps && !customSlippage ? "slippage-btn-active" : ""}`}
                onClick={() => {
                  setSlippageBps(preset.bps);
                  setCustomSlippage(false);
                  setQuoted(null);
                }}
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              className={`slippage-btn ${customSlippage ? "slippage-btn-active" : ""}`}
              onClick={() => setCustomSlippage(true)}
            >
              Custom
            </button>
          </div>
          {customSlippage && (
            <div className="custom-slippage-row">
              <input
                type="number"
                min="0"
                max="300"
                value={slippageBps}
                onChange={(e) => {
                  setSlippageBps(e.target.value);
                  setQuoted(null);
                }}
                className="custom-slippage-input"
                placeholder="Basis points (max 300)"
              />
              <span className="custom-slippage-hint">Max 300 bps (3.0%)</span>
            </div>
          )}
        </div>

        {/* Action Button */}
        <div className="swap-action-bar">
          <button
            type="button"
            className="btn-primary swap-quote-btn"
            disabled={busy || baseAmount === "0" || inputFormatError !== null}
            onClick={() => void handleRefreshQuote()}
          >
            {busy ? "Fetching Route & Quote..." : quoted === null ? "Get Swap Quote" : "Refresh Quote"}
          </button>
        </div>

        {/* Quoted Route & Review Panel */}
        {view !== null && quoted !== null && (
          <div className="swap-quote-review-card">
            <div className="swap-quote-header">
              <h4>Route & Execution Review</h4>
              {expiryState && <span className={`expiry-badge expiry-${expiryState.status}`}>{expiryState.text}</span>}
            </div>

            {/* Route Legs */}
            <div className="swap-route-box">
              <span className="route-header-label">Execution Route (Bitflow DLMM)</span>
              <ol className="route-leg-list">
                {view.route.map((leg) => (
                  <li key={`${leg.contractId}:${leg.functionName}`} className="route-leg-item">
                    <span className="route-contract">{leg.contractId}</span>
                    <span className="route-function">↳ {leg.functionName}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Reconciliation and Verification Flags */}
            <div className="verification-badges-row">
              {assetReconciliation?.reconciled ? (
                <span className="badge badge-success">✓ Assets & Decimals Reconciled</span>
              ) : (
                <span className="badge badge-danger">
                  ⚠ Unreconciled: {assetReconciliation?.reason ?? "Decimal mismatch"}
                </span>
              )}

              {minimumOutputEnforcement?.enforced ? (
                <span className="badge badge-success">✓ Onchain Min-Out Enforced</span>
              ) : (
                <span className="badge badge-danger">
                  ⚠ Min-Out Not Enforced: {minimumOutputEnforcement?.reason ?? "Floor breached"}
                </span>
              )}
            </div>

            {/* Metrics Breakdown */}
            <div className="swap-metrics-grid">
              <div className="swap-metric-card">
                <span className="metric-label">You Send</span>
                <span className="metric-value">{view.sending}</span>
                <span className="metric-sub">
                  ~{fromBaseUnits(quoted.quote.input[0]?.quantity ?? "0", inputAsset.decimals)} {inputAsset.symbol}
                </span>
              </div>

              <div className="swap-metric-card">
                <span className="metric-label">Expected Output</span>
                <span className="metric-value">{view.expectedReceived}</span>
                <span className="metric-sub">
                  ~{fromBaseUnits(quoted.quote.expectedOutput[0]?.quantity ?? "0", outputAsset.decimals)}{" "}
                  {outputAsset.symbol}
                </span>
              </div>

              <div className="swap-metric-card highlight-card">
                <span className="metric-label">Guaranteed Minimum</span>
                <span className="metric-value">{view.minimumReceived ?? "No Floor"}</span>
                <span className="metric-sub">Enforced onchain (post-condition deny)</span>
              </div>

              <div className="swap-metric-card">
                <span className="metric-label">Price Impact</span>
                <span className={`metric-value impact-${impactTier}`}>
                  {view.impactBps === null ? "Unknown" : `${(Number.parseInt(view.impactBps, 10) / 100).toFixed(2)}%`}
                </span>
                <span className="metric-sub">{view.impactNote ?? `${view.impactBps ?? 0} bps vs oracle`}</span>
              </div>
            </div>

            {/* Warnings */}
            {view.warnings.length > 0 && (
              <div className="swap-warnings-box" role="alert">
                {view.warnings.map((warning) => (
                  <p key={warning} className="warn-text">
                    ⚠ {warning}
                  </p>
                ))}
              </div>
            )}

            {/* Expiry / Sign States */}
            {view.expired || view.needsRefresh ? (
              <StaleDisputedStateView
                state={{
                  kind: "stale_disputed",
                  ageDescription: view.expired
                    ? "past its valid expiry time"
                    : `only ${view.expiresInSeconds}s remaining (too close to safely sign)`,
                  sources: [MARKET_ID],
                  onRequote: () => void handleRefreshQuote(),
                }}
              />
            ) : (
              <ReviewStateView
                state={{
                  kind: "review",
                  giveAmount: view.sending,
                  receiveAmount: view.expectedReceived,
                  fees: quoted.quote.fees.map((fee) => ({
                    kind: fee.kind,
                    amount: fee.amount.quantity,
                    ...(fee.amount.asset ? { asset: fee.amount.asset } : {}),
                  })),
                  ...(view.minimumReceived === null ? {} : { minimumOutput: view.minimumReceived }),
                  protocol: "Bitflow",
                  contract: contractOf(quoted.plan.steps),
                  planValidated: isSignable && !busy,
                  ...(isSignable
                    ? {}
                    : {
                        validationError:
                          assetReconciliation?.reason ||
                          minimumOutputEnforcement?.reason ||
                          view.warnings.join(" ") ||
                          "This quote cannot be approved safely.",
                      }),
                  onConfirm: () => void handleApprove(),
                }}
              />
            )}
          </div>
        )}

        {/* Error Feedback */}
        {problem !== null && (
          <div className="swap-problem-alert" role="alert">
            <span className="problem-icon">⚠</span>
            <span className="problem-text">{problem}</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
