import type { Quote } from "@stacks-capital/client";
import type { StacksNetwork } from "@stacks-capital/core";

/** Where the earn flow stands. The workflow's own state decides it, never the screen. */
export type EarnStage = "compare" | "review" | "signing" | "confirming" | "recovery" | "done";

const STAGES: Record<string, EarnStage> = {
  DRAFT: "review",
  QUOTED: "review",
  AWAITING_SIGNATURE: "signing",
  SUBMITTED: "confirming",
  CONFIRMING: "confirming",
  STEP_CONFIRMED: "confirming",
  RECONCILING: "confirming",
  COMPLETED: "done",
  BROADCAST_UNKNOWN: "recovery",
  ACTION_REQUIRED: "recovery",
  MANUAL_REVIEW: "recovery",
  REORGED: "recovery",
  FAILED: "recovery",
};

export function stageFor(workflowState: string | null): EarnStage {
  if (workflowState === null) return "review";
  // An unknown state is treated as needing a human, never as finished.
  return STAGES[workflowState] ?? "recovery";
}

export type Pending = { workflowId: string; stepId: string };
export type Scope = { network: StacksNetwork; address: string; tenantId?: string | null };

export function pendingKey(scope: Scope): string {
  const tenantPrefix = scope.tenantId ? `${scope.tenantId}:` : "";
  return `stacks-capital:pending:${tenantPrefix}${scope.network}:${scope.address}`;
}

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * The pending step is remembered per network and address, so a reload comes back to the same step
 * and another wallet never sees it. Storage can fail (private windows), and that is not fatal.
 */
export function savePending(storage: Storage | null, scope: Scope, pending: Pending): void {
  try {
    storage?.setItem(pendingKey(scope), JSON.stringify(pending));
  } catch {
    // A flow that cannot be remembered still works, it just cannot be resumed after a reload.
  }
}

export function loadPending(storage: Storage | null, scope: Scope): Pending | null {
  try {
    const raw = storage?.getItem(pendingKey(scope));
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(raw) as Partial<Pending>;
    if (typeof parsed.workflowId !== "string" || typeof parsed.stepId !== "string") return null;
    return { workflowId: parsed.workflowId, stepId: parsed.stepId };
  } catch {
    return null;
  }
}

export function clearPending(storage: Storage | null, scope: Scope): void {
  try {
    storage?.removeItem(pendingKey(scope));
  } catch {
    // Nothing to do: the entry is scoped, so a leftover only affects a resume prompt.
  }
}

export type QuoteView = {
  input: string;
  expected: string;
  fees: { kind: string; amount: string }[];
  minimumOutput: string | null;
  warnings: string[];
  expiresInSeconds: number;
  expired: boolean;
  executable: boolean;
};

/** What the review screen shows. Amounts stay strings, and an expiry is counted against the clock. */
export function reviewQuote(quote: Quote, now: Date): QuoteView {
  const expiresInSeconds = Math.floor((new Date(quote.expiresAt).getTime() - now.getTime()) / 1000);
  return {
    input: quote.input.map((amount) => `${amount.quantity} ${amount.asset}`).join(", "),
    expected: quote.expectedOutput.map((amount) => `${amount.quantity} ${amount.asset}`).join(", "),
    fees: quote.fees.map((fee) => ({ kind: fee.kind, amount: `${fee.amount.quantity} ${fee.amount.asset}` })),
    minimumOutput:
      quote.minimumOutput === undefined ? null : `${quote.minimumOutput.quantity} ${quote.minimumOutput.asset}`,
    warnings: quote.warnings,
    expiresInSeconds: Math.max(0, expiresInSeconds),
    expired: expiresInSeconds <= 0,
    executable: quote.executable,
  };
}

/** A quote that expired or was never executable must not be signed. */
export function canSign(view: QuoteView): boolean {
  return view.executable && !view.expired;
}

export type Attempt = { stepId: string; outcome: "BROADCAST" | "SIGNED" | "UNKNOWN"; txid: string | null };

/**
 * The transaction id to show and link, or null when there is none to show.
 *
 * An attempt without a txid is not a failure to look up again later, it is an unknown broadcast. The
 * caller has to treat null as "investigate", never as "try again", because a second broadcast could
 * move the money twice.
 */
export function attemptTxid(attempts: readonly Attempt[]): string | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt !== undefined && attempt.txid !== null) return attempt.txid;
  }
  return null;
}

/** The contract the wallet is actually asked to sign against. Unnamed stays unnamed, never the market id. */
export function contractOf(steps: readonly { payload: Record<string, unknown> }[]): string {
  const contractId = steps[0]?.payload.contractId;
  return typeof contractId === "string" ? contractId : "not named by the plan";
}
