import { capabilityFor, contract, PROVIDERS } from "@stacks-capital/config";
import { parseQuantity, type StacksNetwork } from "@stacks-capital/core";
import type { EmilyFetch } from "./depositLifecycle.ts";

export const EMILY_WITHDRAWAL_STATUSES = ["pending", "accepted", "confirmed", "failed"] as const;
export type EmilyWithdrawalStatus = (typeof EMILY_WITHDRAWAL_STATUSES)[number];

export type SbtcWithdrawalMetadata = {
  network: StacksNetwork;
  requestId: string;
  stacksTxid: string;
  sender: string;
  recipientVersion: string;
  recipientHashbytes: string;
  amountSats: string;
  maxSignerFeeSats: string;
};

export type EmilyWithdrawal = {
  requestId: string;
  stacksBlockHash: string;
  stacksBlockHeight: number;
  recipientScript: string;
  sender: string;
  amountSats: string;
  lastUpdateHeight: number;
  lastUpdateBlockHash: string;
  status: EmilyWithdrawalStatus;
  statusMessage: string;
  parameters: { maxFeeSats: string };
  expectedFulfillment: { bitcoinBlockHeight: number | null; bitcoinTxid: string | null };
  fulfillment: {
    bitcoinTxid: string;
    bitcoinTxOutputIndex: number;
    stacksTxid: string;
    bitcoinBlockHash: string;
    bitcoinBlockHeight: number;
    btcFeeSats: string;
  } | null;
  txid: string;
};

export type CanonicalWithdrawalRequest = {
  requestId: string;
  stacksTxid: string;
  blockHeight: number;
  blockHash: string;
  amountSats: string;
  maxSignerFeeSats: string;
  sender: string;
  recipientVersion: string;
  recipientHashbytes: string;
  status: boolean | null;
  canonical: boolean;
};

export type CanonicalWithdrawalCompletion = {
  requestId: string;
  payoutTxid: string;
  payoutOutputIndex: number;
  feeSats: string;
  burnBlockHash: string;
  burnBlockHeight: number;
  sweepTxid: string;
  stacksTxid: string;
  canonical: boolean;
};

export type BitcoinPayoutObservation = {
  txid: string;
  outputIndex: number;
  amountSats: string;
  scriptPubKey: string;
  blockHeight: number;
  blockHash: string;
  confirmations: number;
  canonical: boolean;
  source: string;
};

export type SbtcWithdrawalState =
  | "unavailable"
  | "request_confirming"
  | "signer_processing"
  | "signer_rejection_pending"
  | "payout_confirming"
  | "rejected"
  | "reconciliation_failed"
  | "reconciled";

export type SbtcWithdrawalLifecycle = {
  transferId: string;
  state: SbtcWithdrawalState;
  complete: boolean;
  nextAction: "WAIT" | "CONTACT_SUPPORT" | "COMPLETE" | "NONE";
  broadcastAllowed: false;
  availability: { available: boolean; reason: string | null };
  contracts: { withdrawal: string; registry: string; token: string };
  request: {
    requestId: string;
    stacksTxid: string;
    canonical: boolean | null;
    status: "pending" | "accepted" | "rejected" | null;
  };
  signer: {
    status: EmilyWithdrawalStatus | null;
    message: string | null;
    lastUpdateHeight: number | null;
    lastUpdateBlockHash: string | null;
    expectedPayoutTxid: string | null;
    expectedPayoutBlockHeight: number | null;
  };
  bitcoin: {
    txid: string | null;
    outputIndex: number | null;
    amountSats: string | null;
    confirmations: number | null;
    canonical: boolean | null;
    source: string | null;
  };
  accounting: {
    withdrawalAmountSats: string;
    maximumSignerFeeSats: string;
    initiallyLockedSats: string;
    actualSignerFeeSats: string | null;
    finalSbtcDebitSats: string | null;
    refundedSbtcSats: string | null;
    returnedAfterRejectionSats: string | null;
    bitcoinReceivedSats: string | null;
  };
  recipientScript: string;
  completion: CanonicalWithdrawalCompletion | null;
  warnings: readonly string[];
};

const HEX = /^(?:[0-9a-fA-F]{2})+$/;
const TXID = /^(?:0x)?[0-9a-fA-F]{64}$/;

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function safeUint(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return value;
}

function uintString(value: unknown, name: string): string {
  if (typeof value === "string") {
    const parsed = parseQuantity(value);
    if (parsed < 0n) throw new Error(`${name} cannot be negative`);
    return parsed.toString(10);
  }
  return safeUint(value, name).toString(10);
}

function txid(value: unknown, name: string): string {
  const parsed = nonEmpty(value, name);
  if (!TXID.test(parsed)) throw new Error(`${name} must be 32-byte hex`);
  return parsed.replace(/^0x/i, "").toLowerCase();
}

function hex(value: unknown, name: string): string {
  const parsed = nonEmpty(value, name);
  if (!HEX.test(parsed)) throw new Error(`${name} must be non-empty byte hex`);
  return parsed.toLowerCase();
}

function optionalTxid(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : txid(value, name);
}

function optionalHeight(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : safeUint(value, name);
}

function parseFulfillment(value: unknown): EmilyWithdrawal["fulfillment"] {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("fulfillment must be an object or null");
  const record = value as Record<string, unknown>;
  return {
    bitcoinTxid: txid(record.BitcoinTxid, "fulfillment.BitcoinTxid"),
    bitcoinTxOutputIndex: safeUint(record.BitcoinTxIndex, "fulfillment.BitcoinTxIndex"),
    stacksTxid: txid(record.StacksTxid, "fulfillment.StacksTxid"),
    bitcoinBlockHash: txid(record.BitcoinBlockHash, "fulfillment.BitcoinBlockHash"),
    bitcoinBlockHeight: safeUint(record.BitcoinBlockHeight, "fulfillment.BitcoinBlockHeight"),
    btcFeeSats: uintString(record.BtcFee, "fulfillment.BtcFee"),
  };
}

export function parseEmilyWithdrawal(value: unknown): EmilyWithdrawal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Emily withdrawal must be an object");
  }
  const record = value as Record<string, unknown>;
  const parameters = record.parameters;
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw new Error("parameters must be an object");
  }
  const expected = record.expectedFulfillmentInfo;
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    throw new Error("expectedFulfillmentInfo must be an object");
  }
  const status = nonEmpty(record.status, "status");
  if (!(EMILY_WITHDRAWAL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unsupported Emily withdrawal status: ${status}`);
  }
  const expectedRecord = expected as Record<string, unknown>;
  return {
    requestId: uintString(record.requestId, "requestId"),
    stacksBlockHash: txid(record.stacksBlockHash, "stacksBlockHash"),
    stacksBlockHeight: safeUint(record.stacksBlockHeight, "stacksBlockHeight"),
    recipientScript: hex(record.recipient, "recipient"),
    sender: nonEmpty(record.sender, "sender"),
    amountSats: uintString(record.amount, "amount"),
    lastUpdateHeight: safeUint(record.lastUpdateHeight, "lastUpdateHeight"),
    lastUpdateBlockHash: txid(record.lastUpdateBlockHash, "lastUpdateBlockHash"),
    status: status as EmilyWithdrawalStatus,
    statusMessage: nonEmpty(record.statusMessage, "statusMessage"),
    parameters: {
      maxFeeSats: uintString((parameters as Record<string, unknown>).maxFee, "parameters.maxFee"),
    },
    expectedFulfillment: {
      bitcoinBlockHeight: optionalHeight(
        expectedRecord.bitcoinBlockHeight,
        "expectedFulfillmentInfo.bitcoinBlockHeight",
      ),
      bitcoinTxid: optionalTxid(expectedRecord.bitcoinTxid, "expectedFulfillmentInfo.bitcoinTxid"),
    },
    fulfillment: parseFulfillment(record.fulfillment),
    txid: txid(record.txid, "txid"),
  };
}

export async function fetchEmilyWithdrawal(input: {
  network: StacksNetwork;
  requestId: string;
  fetch: EmilyFetch;
  signal?: AbortSignal;
}): Promise<EmilyWithdrawal | null> {
  const requestId = uintString(input.requestId, "requestId");
  const response = await input.fetch(`${PROVIDERS[input.network].emily}/withdrawal/${requestId}`, {
    headers: { accept: "application/json" },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Emily withdrawal read failed with HTTP ${response.status}`);
  return parseEmilyWithdrawal(await response.json());
}

export function withdrawalRecipientScript(version: string, hashbytes: string): string {
  if (!/^[0-9a-fA-F]{2}$/.test(version)) throw new Error("recipient version must be exactly one byte");
  const kind = Number.parseInt(version, 16);
  if (kind > 6) throw new Error("recipient version must be between 00 and 06");
  const normalizedHash = hex(hashbytes, "recipient hashbytes");
  const expectedBytes = kind <= 4 ? 20 : 32;
  if (normalizedHash.length !== expectedBytes * 2) {
    throw new Error(`recipient hashbytes must be ${expectedBytes} bytes for version ${version.toLowerCase()}`);
  }
  if (kind === 0) return `76a914${normalizedHash}88ac`;
  if (kind <= 3) return `a914${normalizedHash}87`;
  if (kind === 4) return `0014${normalizedHash}`;
  if (kind === 5) return `0020${normalizedHash}`;
  return `5120${normalizedHash}`;
}

export function sbtcWithdrawalTransferId(input: Pick<SbtcWithdrawalMetadata, "network" | "requestId">): string {
  return `sbtc-withdrawal:${input.network}:${uintString(input.requestId, "requestId")}`;
}

export function sbtcWithdrawalAvailability(network: StacksNetwork): { available: boolean; reason: string | null } {
  const capability = capabilityFor("withdraw_sbtc", network, "sbtc");
  return capability?.state === "enabled"
    ? { available: true, reason: null }
    : { available: false, reason: capability?.reason ?? "sBTC withdrawal is not registered for this environment" };
}

function contracts(network: StacksNetwork): SbtcWithdrawalLifecycle["contracts"] {
  return {
    withdrawal: contract("sbtc", "sbtc-withdrawal", network).contractId,
    registry: contract("sbtc", "sbtc-registry", network).contractId,
    token: contract("sbtc", "sbtc-token", network).contractId,
  };
}

function validateMetadata(metadata: SbtcWithdrawalMetadata): void {
  uintString(metadata.requestId, "requestId");
  txid(metadata.stacksTxid, "stacksTxid");
  nonEmpty(metadata.sender, "sender");
  withdrawalRecipientScript(metadata.recipientVersion, metadata.recipientHashbytes);
  if (parseQuantity(metadata.amountSats) <= 0n) throw new Error("amountSats must be positive");
  if (parseQuantity(metadata.maxSignerFeeSats) < 0n) throw new Error("maxSignerFeeSats cannot be negative");
}

function requestMismatches(metadata: SbtcWithdrawalMetadata, request: CanonicalWithdrawalRequest): string[] {
  const mismatches: string[] = [];
  if (!request.canonical) mismatches.push("withdrawal request is not canonical");
  if (uintString(request.requestId, "request.requestId") !== uintString(metadata.requestId, "requestId"))
    mismatches.push("request id");
  if (txid(request.stacksTxid, "request.stacksTxid") !== txid(metadata.stacksTxid, "stacksTxid"))
    mismatches.push("request Stacks txid");
  if (uintString(request.amountSats, "request.amountSats") !== parseQuantity(metadata.amountSats).toString(10))
    mismatches.push("request amount");
  if (
    uintString(request.maxSignerFeeSats, "request.maxSignerFeeSats") !==
    parseQuantity(metadata.maxSignerFeeSats).toString(10)
  )
    mismatches.push("request maximum signer fee");
  if (request.sender !== metadata.sender) mismatches.push("request sender");
  if (request.recipientVersion.toLowerCase() !== metadata.recipientVersion.toLowerCase())
    mismatches.push("request recipient version");
  if (request.recipientHashbytes.toLowerCase() !== metadata.recipientHashbytes.toLowerCase())
    mismatches.push("request recipient hashbytes");
  return mismatches;
}

function emilyMismatches(
  metadata: SbtcWithdrawalMetadata,
  request: CanonicalWithdrawalRequest | null,
  emily: EmilyWithdrawal,
): string[] {
  const mismatches: string[] = [];
  if (emily.requestId !== uintString(metadata.requestId, "requestId")) mismatches.push("Emily request id");
  if (emily.txid !== txid(metadata.stacksTxid, "stacksTxid")) mismatches.push("Emily request Stacks txid");
  if (emily.sender !== metadata.sender) mismatches.push("Emily sender");
  if (emily.recipientScript !== withdrawalRecipientScript(metadata.recipientVersion, metadata.recipientHashbytes))
    mismatches.push("Emily recipient");
  if (emily.amountSats !== parseQuantity(metadata.amountSats).toString(10)) mismatches.push("Emily amount");
  if (emily.parameters.maxFeeSats !== parseQuantity(metadata.maxSignerFeeSats).toString(10))
    mismatches.push("Emily maximum signer fee");
  if (request !== null && emily.stacksBlockHeight !== request.blockHeight)
    mismatches.push("Emily request block height");
  if (request !== null && emily.stacksBlockHash !== txid(request.blockHash, "request.blockHash"))
    mismatches.push("Emily request block hash");
  return mismatches;
}

function completionMismatches(metadata: SbtcWithdrawalMetadata, completion: CanonicalWithdrawalCompletion): string[] {
  const mismatches: string[] = [];
  if (!completion.canonical) mismatches.push("completion is not canonical");
  if (uintString(completion.requestId, "completion.requestId") !== uintString(metadata.requestId, "requestId"))
    mismatches.push("completion request id");
  if (parseQuantity(completion.feeSats) > parseQuantity(metadata.maxSignerFeeSats))
    mismatches.push("completion fee exceeds maximum");
  return mismatches;
}

function payoutMismatches(
  metadata: SbtcWithdrawalMetadata,
  completion: CanonicalWithdrawalCompletion | null,
  emily: EmilyWithdrawal | null,
  payout: BitcoinPayoutObservation,
): string[] {
  const mismatches: string[] = [];
  if (!payout.canonical) mismatches.push("Bitcoin payout is not canonical");
  if (uintString(payout.amountSats, "payout.amountSats") !== parseQuantity(metadata.amountSats).toString(10))
    mismatches.push("Bitcoin payout amount");
  if (
    payout.scriptPubKey.toLowerCase() !==
    withdrawalRecipientScript(metadata.recipientVersion, metadata.recipientHashbytes)
  )
    mismatches.push("Bitcoin payout recipient");
  if (completion !== null) {
    if (txid(payout.txid, "payout.txid") !== txid(completion.payoutTxid, "completion.payoutTxid"))
      mismatches.push("Bitcoin payout txid");
    if (payout.outputIndex !== completion.payoutOutputIndex) mismatches.push("Bitcoin payout output index");
    if (txid(payout.blockHash, "payout.blockHash") !== txid(completion.burnBlockHash, "completion.burnBlockHash"))
      mismatches.push("Bitcoin payout block hash");
    if (payout.blockHeight !== completion.burnBlockHeight) mismatches.push("Bitcoin payout block height");
  }
  if (emily?.fulfillment !== null && emily?.fulfillment !== undefined) {
    const fulfillment = emily.fulfillment;
    if (txid(payout.txid, "payout.txid") !== fulfillment.bitcoinTxid) mismatches.push("Emily payout txid");
    if (payout.outputIndex !== fulfillment.bitcoinTxOutputIndex) mismatches.push("Emily payout output index");
    if (txid(payout.blockHash, "payout.blockHash") !== fulfillment.bitcoinBlockHash)
      mismatches.push("Emily payout block hash");
    if (payout.blockHeight !== fulfillment.bitcoinBlockHeight) mismatches.push("Emily payout block height");
  }
  return mismatches;
}

/** Rebuild the complete withdrawal view from persisted identifiers and canonical evidence after any reload. */
export function evaluateSbtcWithdrawal(input: {
  metadata: SbtcWithdrawalMetadata;
  request: CanonicalWithdrawalRequest | null;
  emily: EmilyWithdrawal | null;
  completion: CanonicalWithdrawalCompletion | null;
  payout: BitcoinPayoutObservation | null;
  providerTimedOut?: boolean;
}): SbtcWithdrawalLifecycle {
  validateMetadata(input.metadata);
  const metadata = input.metadata;
  const availability = sbtcWithdrawalAvailability(metadata.network);
  const warnings: string[] = [];
  if (input.providerTimedOut === true)
    warnings.push("Emily status read timed out; the existing request remains pending");

  const requestMismatch = input.request === null ? [] : requestMismatches(metadata, input.request);
  const emilyMismatch = input.emily === null ? [] : emilyMismatches(metadata, input.request, input.emily);
  const completionMismatch = input.completion === null ? [] : completionMismatches(metadata, input.completion);
  const payoutMismatch =
    input.payout === null ? [] : payoutMismatches(metadata, input.completion, input.emily, input.payout);
  if (requestMismatch.length > 0) warnings.push(`Canonical request mismatch: ${requestMismatch.join(", ")}`);
  if (emilyMismatch.length > 0) warnings.push(`Emily evidence mismatch: ${emilyMismatch.join(", ")}`);
  if (completionMismatch.length > 0) warnings.push(`Canonical completion mismatch: ${completionMismatch.join(", ")}`);
  if (payoutMismatch.length > 0) warnings.push(`Bitcoin payout mismatch: ${payoutMismatch.join(", ")}`);
  let hasMismatch =
    requestMismatch.length > 0 ||
    emilyMismatch.length > 0 ||
    completionMismatch.length > 0 ||
    payoutMismatch.length > 0;

  if (input.completion !== null && input.request?.status !== true) {
    warnings.push("Canonical completion exists without an accepted canonical withdrawal request");
    hasMismatch = true;
  }
  if (input.payout !== null && input.completion === null) {
    warnings.push("Bitcoin payout cannot be attributed without canonical completion evidence");
    hasMismatch = true;
  }
  if (input.emily?.status === "failed" && (input.request?.status === true || input.completion !== null)) {
    warnings.push("Emily signer failure contradicts canonical acceptance or completion");
    hasMismatch = true;
  }
  if (input.emily?.status === "confirmed" && input.request?.status === false) {
    warnings.push("Emily confirmation contradicts canonical rejection");
    hasMismatch = true;
  }
  if (input.emily?.fulfillment !== null && input.emily?.fulfillment !== undefined && input.completion !== null) {
    const fulfillment = input.emily.fulfillment;
    const differences: string[] = [];
    if (fulfillment.bitcoinTxid !== txid(input.completion.payoutTxid, "completion.payoutTxid"))
      differences.push("txid");
    if (fulfillment.bitcoinTxOutputIndex !== input.completion.payoutOutputIndex) differences.push("output index");
    if (fulfillment.stacksTxid !== txid(input.completion.stacksTxid, "completion.stacksTxid"))
      differences.push("Stacks completion txid");
    if (fulfillment.bitcoinBlockHash !== txid(input.completion.burnBlockHash, "completion.burnBlockHash"))
      differences.push("Bitcoin block hash");
    if (fulfillment.bitcoinBlockHeight !== input.completion.burnBlockHeight) differences.push("Bitcoin block height");
    if (fulfillment.btcFeeSats !== parseQuantity(input.completion.feeSats).toString(10)) differences.push("fee");
    if (differences.length > 0) {
      warnings.push(`Emily fulfillment does not match canonical completion: ${differences.join(", ")}`);
      hasMismatch = true;
    }
  }
  const payoutConfirmations =
    input.payout === null ? null : safeUint(input.payout.confirmations, "payout.confirmations");
  if (payoutConfirmations === 0) warnings.push("Bitcoin payout has no confirmation yet");

  let state: SbtcWithdrawalState;
  if (!availability.available) state = "unavailable";
  else if (hasMismatch) state = "reconciliation_failed";
  else if (input.request?.status === false) state = "rejected";
  else if (
    input.completion !== null &&
    input.payout !== null &&
    payoutConfirmations !== null &&
    payoutConfirmations > 0
  )
    state = "reconciled";
  else if (input.completion !== null || input.emily?.status === "confirmed") state = "payout_confirming";
  else if (input.emily?.status === "failed") state = "signer_rejection_pending";
  else if (input.request !== null || input.emily?.status === "accepted" || input.emily?.status === "pending")
    state = "signer_processing";
  else state = "request_confirming";

  const amount = parseQuantity(metadata.amountSats);
  const maximumFee = parseQuantity(metadata.maxSignerFeeSats);
  const actualFee = input.completion === null ? null : parseQuantity(input.completion.feeSats);
  const complete = state === "reconciled" || state === "rejected";
  const nextAction =
    state === "unavailable"
      ? "NONE"
      : state === "reconciliation_failed"
        ? "CONTACT_SUPPORT"
        : complete
          ? "COMPLETE"
          : "WAIT";

  return {
    transferId: sbtcWithdrawalTransferId(metadata),
    state,
    complete,
    nextAction,
    broadcastAllowed: false,
    availability,
    contracts: contracts(metadata.network),
    request: {
      requestId: uintString(metadata.requestId, "requestId"),
      stacksTxid: txid(metadata.stacksTxid, "stacksTxid"),
      canonical: input.request?.canonical ?? null,
      status:
        input.request === null
          ? null
          : input.request.status === null
            ? "pending"
            : input.request.status
              ? "accepted"
              : "rejected",
    },
    signer: {
      status: input.emily?.status ?? null,
      message: input.emily?.statusMessage ?? null,
      lastUpdateHeight: input.emily?.lastUpdateHeight ?? null,
      lastUpdateBlockHash: input.emily?.lastUpdateBlockHash ?? null,
      expectedPayoutTxid: input.emily?.expectedFulfillment.bitcoinTxid ?? null,
      expectedPayoutBlockHeight: input.emily?.expectedFulfillment.bitcoinBlockHeight ?? null,
    },
    bitcoin: {
      txid: input.payout === null ? null : txid(input.payout.txid, "payout.txid"),
      outputIndex: input.payout?.outputIndex ?? null,
      amountSats: input.payout === null ? null : uintString(input.payout.amountSats, "payout.amountSats"),
      confirmations: payoutConfirmations,
      canonical: input.payout?.canonical ?? null,
      source: input.payout?.source ?? null,
    },
    accounting: {
      withdrawalAmountSats: amount.toString(10),
      maximumSignerFeeSats: maximumFee.toString(10),
      initiallyLockedSats: (amount + maximumFee).toString(10),
      actualSignerFeeSats: actualFee?.toString(10) ?? null,
      finalSbtcDebitSats: actualFee === null || state !== "reconciled" ? null : (amount + actualFee).toString(10),
      refundedSbtcSats: actualFee === null || state !== "reconciled" ? null : (maximumFee - actualFee).toString(10),
      returnedAfterRejectionSats: state === "rejected" ? (amount + maximumFee).toString(10) : null,
      bitcoinReceivedSats:
        state === "reconciled" && input.payout !== null
          ? uintString(input.payout.amountSats, "payout.amountSats")
          : null,
    },
    recipientScript: withdrawalRecipientScript(metadata.recipientVersion, metadata.recipientHashbytes),
    completion: input.completion,
    warnings,
  };
}
