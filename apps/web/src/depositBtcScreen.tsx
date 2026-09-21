import type { QuotedPlan, StartedWorkflow } from "@stacks-capital/client";
import { useCapital, useWorkflow, useWorkflows } from "@stacks-capital/react";
import { createCapitalOS, parsePlan, parseQuote, type PlanWire, type QuoteWire } from "@stacks-capital/sdk";
import type { WalletId } from "@stacks-capital/wallets";
import { useEffect, useState } from "react";
import {
  askWallet,
  attemptTxid,
  calculateDepositAccounting,
  calculateWithdrawalAccounting,
  type ConnectedWallet,
  contractOf,
  EmptyStateView,
  explorerTxUrl,
  FailedDelayedStateView,
  findLatestSbtcWorkflow,
  findProvider,
  isAttemptBroadcastUnknown,
  messageFor,
  Panel,
  ReviewStateView,
  type SbtcBridgeMode,
  stageForDeposit,
  stageForWithdrawal,
  SubmittedStateView,
  toWalletRequest,
  UnsupportedStateView,
  validateBtcRecipient,
} from "@stacks-capital/ui";

const idempotencyKey = () => `idem_${crypto.randomUUID()}`;

function sdkValidation(plan: QuotedPlan["plan"], quote: QuotedPlan["quote"], sender: string) {
  const os = createCapitalOS({ network: plan.network });
  return os.validate(parsePlan(plan as PlanWire), parseQuote(quote as QuoteWire), { sender });
}

export function DepositBtcScreen({ wallet, signedIn }: { wallet: ConnectedWallet | null; signedIn: boolean }) {
  const { client } = useCapital();
  const [mode, setMode] = useState<SbtcBridgeMode>("deposit");

  // Form states
  const [amount, setAmount] = useState("100000");
  const [maxFee, setMaxFee] = useState("1000");
  const [recipient, setRecipient] = useState("04:00112233445566778899aabbccddeeff00112233");

  const [quoted, setQuoted] = useState<QuotedPlan | null>(null);
  const [started, setStarted] = useState<StartedWorkflow | null>(null);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Workflow recovery from API list
  const userWorkflows = useWorkflows({ enabled: signedIn, limit: 20 });
  const currentAction = mode === "deposit" ? "deposit_sbtc" : "withdraw_sbtc";

  // If no active workflow is selected locally, recover latest unfinished from API
  useEffect(() => {
    if (activeWorkflowId !== null || !userWorkflows.data?.items) return;
    const latest = findLatestSbtcWorkflow(userWorkflows.data.items, currentAction, wallet?.network);
    if (latest !== null && latest.state !== "COMPLETED" && latest.state !== "RECONCILED") {
      setActiveWorkflowId(latest.id);
    }
  }, [activeWorkflowId, userWorkflows.data, currentAction, wallet?.network]);

  const workflowQuery = useWorkflow(activeWorkflowId, { staleMs: 5_000 });
  const workflowData = workflowQuery.data?.data ?? null;

  // Compute stage
  const workflowState = workflowData?.state ?? started?.state ?? null;
  const stage = mode === "deposit" ? stageForDeposit(workflowState) : stageForWithdrawal(workflowState);

  // Attempts and broadcast safety
  const attempts = workflowData?.attempts ?? [];
  const txid = attemptTxid(attempts);
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
  const broadcastUnknown = isAttemptBroadcastUnknown(latestAttempt);

  // Testnet capability check
  if (wallet?.network === "testnet") {
    return (
      <Panel title="Bitcoin Bridge">
        <div className="mode-toggle" style={{ marginBottom: "1rem" }}>
          <button
            type="button"
            className={mode === "deposit" ? "btn-primary" : "btn-secondary"}
            onClick={() => setMode("deposit")}
          >
            Deposit (BTC → sBTC)
          </button>{" "}
          <button
            type="button"
            className={mode === "withdraw" ? "btn-primary" : "btn-secondary"}
            onClick={() => setMode("withdraw")}
          >
            Withdraw (sBTC → BTC)
          </button>
        </div>
        <UnsupportedStateView
          state={{
            kind: "unsupported",
            assetOrProtocol: mode === "deposit" ? "Bitcoin (BTC) to sBTC Deposit" : "sBTC to Bitcoin (BTC) Withdrawal",
            reason:
              mode === "deposit"
                ? "Emily beta does not track public Stacks testnet. Leather has no Bitcoin regtest (I01 F2)."
                : "Same testnet signer/Emily mismatch as deposit (I01 F2).",
          }}
        />
      </Panel>
    );
  }

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Bitcoin Bridge">
        <EmptyStateView
          state={{
            kind: "empty",
            instruction: "Connect a wallet and sign in to deposit or withdraw Bitcoin.",
          }}
        />
      </Panel>
    );
  }

  const recipientCheck = mode === "withdraw" ? validateBtcRecipient(recipient) : { valid: true };

  async function getQuote() {
    if (wallet === null) return;
    setBusy(true);
    setProblem(null);
    try {
      if (mode === "deposit") {
        const result = await client.quote({
          marketId: "sbtc.deposit",
          action: "deposit_sbtc",
          amount,
          maxFee,
          owner: wallet.address,
        });
        setQuoted(result.data);
      } else {
        if (!recipientCheck.valid) {
          throw new Error(recipientCheck.error ?? "Invalid Bitcoin recipient");
        }
        const result = await client.quote({
          marketId: "sbtc.withdraw",
          action: "withdraw_sbtc",
          amount,
          maxFee,
          recipient,
          owner: wallet.address,
        });
        setQuoted(result.data);
      }
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signAndSubmit() {
    if (quoted === null || wallet === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const start = await client.startWorkflow({
        quoteId: quoted.quote.id,
        idempotencyKey: idempotencyKey(),
      });
      setStarted(start.data);
      setActiveWorkflowId(start.data.workflowId);

      const step = start.data.plan.steps[0];
      if (step === undefined) throw new Error("The plan has no step to sign");
      const provider = findProvider(wallet.id as WalletId);
      if (provider === null) throw new Error(`${wallet.id} is not available any more`);

      const validation = sdkValidation(start.data.plan, quoted.quote, wallet.address);
      const answer = await askWallet(provider, wallet.id as WalletId, toWalletRequest(step, validation), validation);
      if (answer.kind === "rejected") {
        setProblem(answer.message);
        return;
      }

      await client.recordSignature(start.data.workflowId, {
        stepId: step.id,
        walletResult: answer.result,
      });
      await workflowQuery.refresh();
      await userWorkflows.refresh();
    } catch (error) {
      setProblem(messageFor(error).message);
    } finally {
      setBusy(false);
    }
  }

  function resetForm() {
    setQuoted(null);
    setStarted(null);
    setActiveWorkflowId(null);
    setProblem(null);
  }

  // Accounting summaries
  const depositAcc =
    mode === "deposit" ? calculateDepositAccounting({ amountSats: amount || "0", maxFeeSats: maxFee || "0" }) : null;
  const withdrawAcc =
    mode === "withdraw"
      ? calculateWithdrawalAccounting({ amountSats: amount || "0", maxFeeSats: maxFee || "0" })
      : null;

  return (
    <Panel title={mode === "deposit" ? "Deposit Bitcoin" : "Withdraw sBTC"}>
      {/* Mode navigation */}
      <div className="mode-toggle" style={{ marginBottom: "1.5rem" }}>
        <button
          type="button"
          className={mode === "deposit" ? "btn-primary" : "btn-secondary"}
          onClick={() => {
            setMode("deposit");
            resetForm();
          }}
        >
          Deposit (BTC → sBTC)
        </button>{" "}
        <button
          type="button"
          className={mode === "withdraw" ? "btn-primary" : "btn-secondary"}
          onClick={() => {
            setMode("withdraw");
            resetForm();
          }}
        >
          Withdraw (sBTC → BTC)
        </button>
      </div>

      {/* Notice on pending accounting distinction */}
      <div className="panel panel-notice" style={{ marginBottom: "1.2rem" }}>
        <p className="muted" style={{ margin: 0 }}>
          <strong>Accounting notice:</strong> Pending BTC and in-flight transactions are held strictly distinct from
          spendable sBTC. They are never combined into a single balance.
        </p>
      </div>

      {activeWorkflowId !== null && (
        <div
          className="panel panel-active-workflow"
          style={{ marginBottom: "1.2rem", padding: "0.8rem", border: "1px solid var(--border-subtle)" }}
        >
          <p style={{ margin: "0 0 0.5rem 0" }}>
            Viewing workflow: <strong>{activeWorkflowId}</strong> (State: <strong>{workflowState ?? "PENDING"}</strong>)
          </p>
          <button type="button" className="btn-secondary" onClick={resetForm}>
            Start another {mode}
          </button>
        </div>
      )}

      {/* Stage: Form & Quoting */}
      {stage === "form" && activeWorkflowId === null && (
        <div>
          <label style={{ display: "block", marginBottom: "0.8rem" }}>
            Amount in {mode === "deposit" ? "satoshis (BTC)" : "sBTC base units"}
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              style={{ display: "block", width: "100%", marginTop: "0.3rem" }}
            />
          </label>

          <label style={{ display: "block", marginBottom: "0.8rem" }}>
            Maximum signer fee in {mode === "deposit" ? "satoshis" : "sBTC base units"}
            <input
              value={maxFee}
              onChange={(e) => setMaxFee(e.target.value)}
              inputMode="numeric"
              style={{ display: "block", width: "100%", marginTop: "0.3rem" }}
            />
          </label>

          {mode === "withdraw" && (
            <label style={{ display: "block", marginBottom: "0.8rem" }}>
              Destination Bitcoin recipient (version:hashbytes)
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="04:40_hex_chars or 06:64_hex_chars"
                style={{ display: "block", width: "100%", marginTop: "0.3rem" }}
              />
              {!recipientCheck.valid && recipient.trim() !== "" && (
                <span className="error" style={{ fontSize: "0.85rem", color: "var(--error)" }}>
                  {recipientCheck.error}
                </span>
              )}
            </label>
          )}

          {/* Preliminary accounting review */}
          {mode === "deposit" && depositAcc && (
            <div style={{ margin: "1rem 0", fontSize: "0.9rem" }}>
              <p>
                Deposit amount: <strong>{depositAcc.depositAmountSats} satoshis</strong>
              </p>
              <p>
                Maximum signer fee: <strong>{depositAcc.maxSignerFeeSats} satoshis</strong>
              </p>
              <p>
                Minimum expected mint: <strong>{depositAcc.minExpectedSbtcSats} sBTC base units</strong>
              </p>
            </div>
          )}

          {mode === "withdraw" && withdrawAcc && (
            <div style={{ margin: "1rem 0", fontSize: "0.9rem" }}>
              <p>
                Requested Bitcoin output: <strong>{withdrawAcc.withdrawalAmountSats} satoshis</strong>
              </p>
              <p>
                Maximum signer fee: <strong>{withdrawAcc.maximumSignerFeeSats} sBTC base units</strong>
              </p>
              <p>
                Initially locked sBTC: <strong>{withdrawAcc.initiallyLockedSats} sBTC base units</strong>
              </p>
            </div>
          )}

          <button
            type="button"
            className="btn-primary"
            disabled={busy || amount === "" || (mode === "withdraw" && !recipientCheck.valid)}
            onClick={() => void getQuote()}
          >
            {busy ? "Fetching quote..." : `Get ${mode} quote`}
          </button>

          {quoted !== null && (
            <div className="quote" style={{ marginTop: "1.5rem" }}>
              <ReviewStateView
                state={{
                  kind: "review",
                  giveAmount:
                    mode === "deposit"
                      ? `${amount} satoshis (BTC)`
                      : `${withdrawAcc?.initiallyLockedSats} sBTC base units`,
                  receiveAmount:
                    mode === "deposit"
                      ? `${depositAcc?.minExpectedSbtcSats} sBTC base units`
                      : `${amount} satoshis (BTC)`,
                  fees: [
                    {
                      kind: "signer",
                      amount: maxFee,
                      asset: mode === "deposit" ? "satoshis" : "sBTC base units",
                    },
                  ],
                  protocol: "sbtc",
                  contract: contractOf(quoted.plan.steps),
                  planValidated: quoted.quote.executable && !busy,
                  ...(quoted.quote.executable
                    ? {}
                    : { validationError: quoted.quote.warnings.join(" ") || "Quote is not executable" }),
                  onConfirm: () => void signAndSubmit(),
                }}
              />
              <p className="muted" style={{ marginTop: "0.8rem", fontSize: "0.85rem" }}>
                {mode === "deposit"
                  ? "Bitcoin confirmation, signer processing, and Stacks mint are separate states. A Bitcoin txid is not completion."
                  : "Workflow completes only after signer acceptance and the Bitcoin payout, not at the Stacks request."}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Stage: Signing */}
      {stage === "signing" && (
        <Panel title="Waiting for wallet signature">
          <p>Please approve the transaction in {wallet.id}. Nothing moves until approved.</p>
        </Panel>
      )}

      {/* Stage: Confirming & In-flight */}
      {stage === "confirming" && (
        <div style={{ marginTop: "1rem" }}>
          {broadcastUnknown || txid === null ? (
            <FailedDelayedStateView
              state={{
                kind: "failed_delayed",
                cause: "The wallet did not return a verified transaction id, or the broadcast state is unknown.",
                fundsLocation: `Whether anything was broadcast is unknown. State: ${workflowState}. Nothing is automatically retried.`,
                recovery: [
                  {
                    type: "support",
                    label: "Copy workflow id",
                    action: () => void navigator.clipboard?.writeText(activeWorkflowId ?? ""),
                  },
                ],
              }}
            />
          ) : (
            <SubmittedStateView
              state={{
                kind: "submitted",
                txId: txid,
                explorerUrl: explorerTxUrl(txid, wallet.network),
                workflowState: workflowState ?? "CONFIRMING",
                differenceNote:
                  mode === "deposit"
                    ? "Deposit submitted. Awaiting Bitcoin block confirmations and Emily signer processing. Never badged as complete until canonical Stacks mint is confirmed."
                    : "withdrawal request submitted; awaiting on-chain request evidence.",
                nextAction:
                  mode === "deposit"
                    ? "Wait for Bitcoin confirmation and signer minting."
                    : "Awaiting canonical withdrawal request evidence and signer processing. Never derived as payout from wallet attempt.",
              }}
            />
          )}

          <div style={{ marginTop: "1rem" }}>
            <button type="button" className="btn-secondary" onClick={() => void workflowQuery.refresh()}>
              Refresh progress
            </button>
          </div>
        </div>
      )}

      {/* Stage: Reclaim (Deposit only) */}
      {stage === "reclaim" && (
        <Panel title="Deposit Reclaim Available">
          <p className="warn">
            The Bitcoin tip has reached Emily's reclaim lock height without a canonical mint. Your deposit funds are
            reclaimable.
          </p>
          <FailedDelayedStateView
            state={{
              kind: "failed_delayed",
              cause: "Deposit was not minted by signers before the reclaim lock height expired.",
              fundsLocation: "Funds remain safely locked in the Bitcoin deposit script address awaiting reclaim.",
              recovery: [
                {
                  type: "reclaim",
                  label: "Reclaim Bitcoin deposit",
                  action: () => {
                    alert("Reclaim transaction can be broadcast using the reclaim script on Bitcoin.");
                  },
                },
              ],
            }}
          />
        </Panel>
      )}

      {/* Stage: Recovery / Attention required */}
      {stage === "recovery" && (
        <FailedDelayedStateView
          state={{
            kind: "failed_delayed",
            cause:
              workflowState === "SIGNER_REJECTION_PENDING"
                ? "Signers rejected the withdrawal request. Funds remain locked in the contract until the canonical registry records the rejection status."
                : workflowState === "RECONCILIATION_FAILED"
                  ? "Evidence mismatch detected during independent reconciliation. The transaction requires investigation."
                  : "Transaction requires attention or failed on-chain. Never retried automatically to prevent moving funds twice.",
            fundsLocation:
              workflowState === "SIGNER_REJECTION_PENDING"
                ? "Locked in sBTC withdrawal contract pending registry confirmation of signer rejection. Funds return atomically upon rejection recording."
                : `Workflow ${activeWorkflowId} in state ${workflowState}.`,
            recovery: [
              {
                type: "support",
                label: "Copy workflow id",
                action: () => void navigator.clipboard?.writeText(activeWorkflowId ?? ""),
              },
            ],
          }}
        />
      )}

      {/* Stage: Done / Reconciled */}
      {stage === "done" && (
        <Panel title="Complete & Reconciled">
          <p className="success" style={{ color: "var(--success, green)" }}>
            ✓ {mode === "deposit" ? "Deposit" : "Withdrawal"} is complete and verified against independent canonical
            evidence.
          </p>
          {mode === "deposit" && (
            <p>
              Minted sBTC has been credited to your Stacks account. Workflow <strong>{activeWorkflowId}</strong> is
              reconciled.
            </p>
          )}
          {mode === "withdraw" && (
            <p>
              Bitcoin payout has been independently verified on the Bitcoin network. Workflow{" "}
              <strong>{activeWorkflowId}</strong> is reconciled.
            </p>
          )}
          <button type="button" className="btn-primary" onClick={resetForm}>
            Done
          </button>
        </Panel>
      )}

      {problem !== null && (
        <p className="error" role="alert" style={{ marginTop: "1rem" }}>
          {problem}
        </p>
      )}
    </Panel>
  );
}
