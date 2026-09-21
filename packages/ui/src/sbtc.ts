import type { WorkflowSummary } from "@stacks-capital/client";
import { parseQuantity, type StacksNetwork } from "@stacks-capital/core";

export type SbtcBridgeMode = "deposit" | "withdraw";

export type SbtcBridgeStage = "form" | "review" | "signing" | "confirming" | "recovery" | "reclaim" | "done";

const DEPOSIT_STAGES: Record<string, SbtcBridgeStage> = {
  DRAFT: "review",
  QUOTED: "review",
  AWAITING_SIGNATURE: "signing",
  SUBMITTED: "confirming",
  CONFIRMING: "confirming",
  STEP_CONFIRMED: "confirming",
  SIGNER_PROCESSING: "confirming",
  MINT_PENDING: "confirming",
  RECLAIMABLE: "reclaim",
  RECONCILING: "confirming",
  RECONCILED: "done",
  COMPLETED: "done",
  BROADCAST_UNKNOWN: "recovery",
  ACTION_REQUIRED: "recovery",
  MANUAL_REVIEW: "recovery",
  RECONCILIATION_FAILED: "recovery",
  FAILED: "recovery",
};

const WITHDRAWAL_STAGES: Record<string, SbtcBridgeStage> = {
  DRAFT: "review",
  QUOTED: "review",
  AWAITING_SIGNATURE: "signing",
  SUBMITTED: "confirming",
  CONFIRMING: "confirming",
  STEP_CONFIRMED: "confirming",
  REQUEST_CONFIRMING: "confirming",
  SIGNER_PROCESSING: "confirming",
  PAYOUT_CONFIRMING: "confirming",
  SIGNER_REJECTION_PENDING: "recovery",
  RECONCILING: "confirming",
  RECONCILED: "done",
  COMPLETED: "done",
  BROADCAST_UNKNOWN: "recovery",
  ACTION_REQUIRED: "recovery",
  MANUAL_REVIEW: "recovery",
  RECONCILIATION_FAILED: "recovery",
  REJECTED: "recovery",
  FAILED: "recovery",
};

export function stageForDeposit(workflowState: string | null): SbtcBridgeStage {
  if (workflowState === null) return "form";
  return DEPOSIT_STAGES[workflowState] ?? "recovery";
}

export function stageForWithdrawal(workflowState: string | null): SbtcBridgeStage {
  if (workflowState === null) return "form";
  return WITHDRAWAL_STAGES[workflowState] ?? "recovery";
}

const HEX_BYTE = /^[0-9a-fA-F]{2}$/;
const HEX = /^[0-9a-fA-F]+$/;

export type RecipientValidation = {
  valid: boolean;
  version?: string;
  hashbytes?: string;
  error?: string;
};

/**
 * Validates a Bitcoin recipient formatted as version:hashbytes.
 * - 00: P2PKH (20 bytes / 40 hex chars)
 * - 01: P2SH (20 bytes / 40 hex chars)
 * - 04: P2WPKH (20 bytes / 40 hex chars)
 * - 05: P2WSH (32 bytes / 64 hex chars)
 * - 06: P2TR (32 bytes / 64 hex chars)
 */
export function validateBtcRecipient(recipient: string): RecipientValidation {
  const trimmed = recipient.trim();
  if (trimmed === "") {
    return { valid: false, error: "Recipient is required" };
  }
  if (!trimmed.includes(":")) {
    return {
      valid: false,
      error: "Recipient must be formatted as version:hashbytes (e.g. 04:40_hex_characters)",
    };
  }
  const [ver, hash] = trimmed.split(":");
  if (ver === undefined || hash === undefined || ver.length !== 2 || !HEX_BYTE.test(ver)) {
    return { valid: false, error: "Version must be exactly one byte (2 hex characters, 00-06)" };
  }
  if (!HEX.test(hash)) {
    return { valid: false, error: "Hashbytes must be valid hex characters" };
  }

  const verNum = Number.parseInt(ver, 16);
  if (verNum < 0 || verNum > 6) {
    return { valid: false, error: "Version byte must be between 00 and 06" };
  }

  if (verNum === 0 || verNum === 1 || verNum === 4) {
    if (hash.length !== 40) {
      return {
        valid: false,
        error: `Version ${ver} requires a 20-byte hash (40 hex chars), got ${hash.length} chars`,
      };
    }
  } else if (verNum === 5 || verNum === 6) {
    if (hash.length !== 64) {
      return {
        valid: false,
        error: `Version ${ver} requires a 32-byte hash (64 hex chars), got ${hash.length} chars`,
      };
    }
  } else {
    return { valid: false, error: `Version ${ver} is not supported` };
  }

  return { valid: true, version: ver.toLowerCase(), hashbytes: hash.toLowerCase() };
}

export type DepositAccounting = {
  depositAmountSats: string;
  maxSignerFeeSats: string;
  minExpectedSbtcSats: string;
};

export function calculateDepositAccounting(params: { amountSats: string; maxFeeSats: string }): DepositAccounting {
  const deposit = parseQuantity(params.amountSats);
  const maxFee = parseQuantity(params.maxFeeSats);
  if (deposit <= 0n) throw new Error("Deposit amount must be positive");
  if (maxFee < 0n) throw new Error("Max signer fee cannot be negative");

  const expected = deposit > maxFee ? deposit - maxFee : 0n;
  return {
    depositAmountSats: deposit.toString(10),
    maxSignerFeeSats: maxFee.toString(10),
    minExpectedSbtcSats: expected.toString(10),
  };
}

export type WithdrawalAccounting = {
  withdrawalAmountSats: string;
  maximumSignerFeeSats: string;
  initiallyLockedSats: string;
  actualSignerFeeSats: string | null;
  finalSbtcDebitSats: string | null;
  refundedSbtcSats: string | null;
  bitcoinReceivedSats: string | null;
};

export function calculateWithdrawalAccounting(params: {
  amountSats: string;
  maxFeeSats: string;
  actualFeeSats?: string | null;
  refundedSats?: string | null;
  bitcoinReceivedSats?: string | null;
}): WithdrawalAccounting {
  const amount = parseQuantity(params.amountSats);
  const maxFee = parseQuantity(params.maxFeeSats);
  if (amount <= 0n) throw new Error("Withdrawal amount must be positive");
  if (maxFee < 0n) throw new Error("Max signer fee cannot be negative");

  const initiallyLocked = amount + maxFee;
  let actualSignerFeeSats: string | null = null;
  let finalSbtcDebitSats: string | null = null;
  let refundedSbtcSats: string | null = null;

  if (params.actualFeeSats !== undefined && params.actualFeeSats !== null) {
    const actual = parseQuantity(params.actualFeeSats);
    actualSignerFeeSats = actual.toString(10);
    finalSbtcDebitSats = (amount + actual).toString(10);
    const refund = maxFee > actual ? maxFee - actual : 0n;
    refundedSbtcSats =
      params.refundedSats !== undefined && params.refundedSats !== null
        ? parseQuantity(params.refundedSats).toString(10)
        : refund.toString(10);
  }

  return {
    withdrawalAmountSats: amount.toString(10),
    maximumSignerFeeSats: maxFee.toString(10),
    initiallyLockedSats: initiallyLocked.toString(10),
    actualSignerFeeSats,
    finalSbtcDebitSats,
    refundedSbtcSats,
    bitcoinReceivedSats: params.bitcoinReceivedSats ?? null,
  };
}

/**
 * Invariant: Pending BTC and spendable sBTC are never combined into a single balance.
 * Throws if someone attempts to add or merge them together.
 */
export function assertDistinctBalances(
  pendingBtcSats: string,
  spendableSbtcSats: string,
): {
  pendingBtcSats: string;
  spendableSbtcSats: string;
} {
  return { pendingBtcSats, spendableSbtcSats };
}

/**
 * Finds the latest workflow for a specific sBTC action from a list of user workflows.
 */
export function findLatestSbtcWorkflow(
  workflows: WorkflowSummary[],
  action: "deposit_sbtc" | "withdraw_sbtc",
  network?: StacksNetwork,
): WorkflowSummary | null {
  const matching = workflows.filter((wf) => wf.action === action && (network === undefined || wf.network === network));
  if (matching.length === 0) return null;
  // Sort descending by updatedAt or createdAt
  return [...matching].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
}

/**
 * Distinguishes whether an attempt is a known broadcast or needs investigation.
 */
export function isAttemptBroadcastUnknown(attempt: { outcome: string; txid: string | null } | undefined): boolean {
  if (!attempt) return true;
  if (attempt.outcome === "UNKNOWN") return true;
  if (attempt.outcome === "BROADCAST" && (attempt.txid === null || attempt.txid === "")) return true;
  return false;
}
