import { contract, PROVIDERS } from "@stacks-capital/config";
import { parseQuantity, type StacksNetwork } from "@stacks-capital/core";

export const EMILY_DEPOSIT_STATUSES = ["pending", "accepted", "confirmed", "failed", "rbf"] as const;
export type EmilyDepositStatus = (typeof EMILY_DEPOSIT_STATUSES)[number];

export type SbtcDepositMetadata = {
  network: StacksNetwork;
  bitcoinTxid: string;
  bitcoinTxOutputIndex: number;
  transactionHex: string;
  depositScript: string;
  reclaimScript: string;
  recipient: string;
  amountSats: string;
  maxSignerFeeSats: string;
};

export type EmilyDeposit = {
  bitcoinTxid: string;
  bitcoinTxOutputIndex: number;
  recipient: string;
  amount: string;
  lastUpdateHeight: number;
  lastUpdateBlockHash: string;
  status: EmilyDepositStatus;
  statusMessage: string;
  parameters: { lockTime: number; maxFee: string };
  reclaimScript: string;
  depositScript: string;
  fulfillment: {
    bitcoinTxid: string;
    bitcoinTxOutputIndex: number;
    stacksTxid: string;
    bitcoinBlockHash: string;
    bitcoinBlockHeight: number;
    btcFeeSats: string;
  } | null;
  replacedByTx: string | null;
};

export type BitcoinDepositObservation = {
  confirmations: number;
  tipHeight: number;
  canonical: boolean;
  source: string;
};

export type CanonicalDepositMint = {
  bitcoinTxid: string;
  bitcoinTxOutputIndex: number;
  amountSats: string;
  recipient: string;
  stacksTxid: string;
  blockHeight: number;
  blockHash: string;
  canonical: boolean;
};

export type SbtcDepositState =
  | "submitted"
  | "confirming"
  | "signer_processing"
  | "mint_pending"
  | "reclaimable"
  | "replaced"
  | "failed"
  | "reconciliation_failed"
  | "reconciled";

export type SbtcDepositLifecycle = {
  transferId: string;
  state: SbtcDepositState;
  complete: boolean;
  nextAction: "WAIT" | "RECLAIM" | "CONTACT_SUPPORT" | "COMPLETE";
  broadcastAllowed: false;
  contracts: { deposit: string; registry: string; token: string };
  bitcoin: {
    txid: string;
    outputIndex: number;
    confirmations: number | null;
    canonical: boolean | null;
    source: string | null;
  };
  signer: {
    status: EmilyDepositStatus | null;
    message: string | null;
    lastUpdateHeight: number | null;
    lastUpdateBlockHash: string | null;
  };
  fees: {
    maximumSignerFeeSats: string;
    actualSignerFeeSats: string | null;
  };
  output: {
    expectedMinimumSats: string;
    mintedSats: string | null;
  };
  recovery: {
    reclaimScript: string;
    lockHeight: number | null;
    currentBitcoinHeight: number | null;
    blocksRemaining: number | null;
    state: "unavailable" | "locked" | "available" | "consumed";
  };
  mint: CanonicalDepositMint | null;
  warnings: readonly string[];
};

export type EmilyFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const TXID = /^[0-9a-fA-F]{64}$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

function assertSafeNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return value;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function int64String(value: unknown, name: string): string {
  if (typeof value === "string") {
    const parsed = parseQuantity(value);
    if (parsed < 0n) throw new Error(`${name} cannot be negative`);
    return parsed.toString(10);
  }
  return assertSafeNonNegativeInteger(value, name).toString(10);
}

function optionalString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, name);
}

function parseFulfillment(value: unknown): EmilyDeposit["fulfillment"] {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("fulfillment must be an object or null");
  const record = value as Record<string, unknown>;
  return {
    bitcoinTxid: assertString(record.BitcoinTxid, "fulfillment.BitcoinTxid"),
    bitcoinTxOutputIndex: assertSafeNonNegativeInteger(record.BitcoinTxIndex, "fulfillment.BitcoinTxIndex"),
    stacksTxid: assertString(record.StacksTxid, "fulfillment.StacksTxid"),
    bitcoinBlockHash: assertString(record.BitcoinBlockHash, "fulfillment.BitcoinBlockHash"),
    bitcoinBlockHeight: assertSafeNonNegativeInteger(record.BitcoinBlockHeight, "fulfillment.BitcoinBlockHeight"),
    btcFeeSats: int64String(record.BtcFee, "fulfillment.BtcFee"),
  };
}

/** Parse the public Emily schema without accepting fields of the wrong type or lossy int64 values. */
export function parseEmilyDeposit(value: unknown): EmilyDeposit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Emily deposit must be an object");
  }
  const record = value as Record<string, unknown>;
  const parameters = record.parameters;
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw new Error("parameters must be an object");
  }
  const parameterRecord = parameters as Record<string, unknown>;
  const status = assertString(record.status, "status");
  if (!(EMILY_DEPOSIT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unsupported Emily deposit status: ${status}`);
  }
  return {
    bitcoinTxid: assertString(record.bitcoinTxid, "bitcoinTxid"),
    bitcoinTxOutputIndex: assertSafeNonNegativeInteger(record.bitcoinTxOutputIndex, "bitcoinTxOutputIndex"),
    recipient: assertString(record.recipient, "recipient"),
    amount: int64String(record.amount, "amount"),
    lastUpdateHeight: assertSafeNonNegativeInteger(record.lastUpdateHeight, "lastUpdateHeight"),
    lastUpdateBlockHash: assertString(record.lastUpdateBlockHash, "lastUpdateBlockHash"),
    status: status as EmilyDepositStatus,
    statusMessage: assertString(record.statusMessage, "statusMessage"),
    parameters: {
      lockTime: assertSafeNonNegativeInteger(parameterRecord.lockTime, "parameters.lockTime"),
      maxFee: int64String(parameterRecord.maxFee, "parameters.maxFee"),
    },
    reclaimScript: assertString(record.reclaimScript, "reclaimScript"),
    depositScript: assertString(record.depositScript, "depositScript"),
    fulfillment: parseFulfillment(record.fulfillment),
    replacedByTx: optionalString(record.replacedByTx, "replacedByTx"),
  };
}

export function sbtcDepositTransferId(
  metadata: Pick<SbtcDepositMetadata, "network" | "bitcoinTxid" | "bitcoinTxOutputIndex">,
): string {
  return `sbtc-deposit:${metadata.network}:${metadata.bitcoinTxid.toLowerCase()}:${metadata.bitcoinTxOutputIndex}`;
}

export function createEmilyDepositNotification(metadata: SbtcDepositMetadata): {
  bitcoinTxid: string;
  bitcoinTxOutputIndex: number;
  reclaimScript: string;
  depositScript: string;
  transactionHex: string;
} {
  validateMetadata(metadata);
  return {
    bitcoinTxid: metadata.bitcoinTxid.toLowerCase(),
    bitcoinTxOutputIndex: metadata.bitcoinTxOutputIndex,
    reclaimScript: metadata.reclaimScript.toLowerCase(),
    depositScript: metadata.depositScript.toLowerCase(),
    transactionHex: metadata.transactionHex.toLowerCase(),
  };
}

export async function fetchEmilyDeposit(input: {
  network: StacksNetwork;
  bitcoinTxid: string;
  bitcoinTxOutputIndex: number;
  fetch: EmilyFetch;
  signal?: AbortSignal;
}): Promise<EmilyDeposit | null> {
  if (!TXID.test(input.bitcoinTxid)) throw new Error("bitcoinTxid must be 32-byte hex");
  assertSafeNonNegativeInteger(input.bitcoinTxOutputIndex, "bitcoinTxOutputIndex");
  const url = `${PROVIDERS[input.network].emily}/deposit/${input.bitcoinTxid.toLowerCase()}/${input.bitcoinTxOutputIndex}`;
  const response = await input.fetch(url, {
    headers: { accept: "application/json" },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Emily deposit read failed with HTTP ${response.status}`);
  return parseEmilyDeposit(await response.json());
}

function validateMetadata(metadata: SbtcDepositMetadata): void {
  if (!TXID.test(metadata.bitcoinTxid)) throw new Error("bitcoinTxid must be 32-byte hex");
  assertSafeNonNegativeInteger(metadata.bitcoinTxOutputIndex, "bitcoinTxOutputIndex");
  if (!HEX.test(metadata.transactionHex)) throw new Error("transactionHex must be non-empty byte hex");
  if (!HEX.test(metadata.depositScript)) throw new Error("depositScript must be non-empty byte hex");
  if (!HEX.test(metadata.reclaimScript)) throw new Error("reclaimScript must be non-empty byte hex");
  assertString(metadata.recipient, "recipient");
  if (parseQuantity(metadata.amountSats) <= 0n) throw new Error("amountSats must be positive");
  if (parseQuantity(metadata.maxSignerFeeSats) < 0n) throw new Error("maxSignerFeeSats cannot be negative");
}

function depositContracts(network: StacksNetwork): SbtcDepositLifecycle["contracts"] {
  return {
    deposit: contract("sbtc", "sbtc-deposit", network).contractId,
    registry: contract("sbtc", "sbtc-registry", network).contractId,
    token: contract("sbtc", "sbtc-token", network).contractId,
  };
}

function emilyMatches(metadata: SbtcDepositMetadata, emily: EmilyDeposit): string[] {
  const mismatches: string[] = [];
  if (emily.bitcoinTxid.toLowerCase() !== metadata.bitcoinTxid.toLowerCase()) mismatches.push("bitcoin txid");
  if (emily.bitcoinTxOutputIndex !== metadata.bitcoinTxOutputIndex) mismatches.push("bitcoin output index");
  if (emily.recipient !== metadata.recipient) mismatches.push("recipient");
  if (emily.amount !== parseQuantity(metadata.amountSats).toString(10)) mismatches.push("deposit amount");
  if (emily.parameters.maxFee !== parseQuantity(metadata.maxSignerFeeSats).toString(10))
    mismatches.push("maximum signer fee");
  if (emily.depositScript.toLowerCase() !== metadata.depositScript.toLowerCase()) mismatches.push("deposit script");
  if (emily.reclaimScript.toLowerCase() !== metadata.reclaimScript.toLowerCase()) mismatches.push("reclaim script");
  return mismatches;
}

function mintMatches(metadata: SbtcDepositMetadata, mint: CanonicalDepositMint, expectedMinimum: bigint): string[] {
  const mismatches: string[] = [];
  if (!mint.canonical) mismatches.push("mint is not canonical");
  if (mint.bitcoinTxid.toLowerCase() !== metadata.bitcoinTxid.toLowerCase()) mismatches.push("mint bitcoin txid");
  if (mint.bitcoinTxOutputIndex !== metadata.bitcoinTxOutputIndex) mismatches.push("mint output index");
  if (mint.recipient !== metadata.recipient) mismatches.push("mint recipient");
  const minted = parseQuantity(mint.amountSats);
  const gross = parseQuantity(metadata.amountSats);
  if (minted < expectedMinimum || minted > gross) mismatches.push("mint amount outside quoted fee bound");
  return mismatches;
}

/**
 * Reconcile signer, Bitcoin and canonical Stacks evidence. Polling is read-only: even on a timeout the
 * decision never authorizes another broadcast, so a delayed provider cannot duplicate the BTC transfer.
 */
export function evaluateSbtcDeposit(input: {
  metadata: SbtcDepositMetadata;
  emily: EmilyDeposit | null;
  bitcoin: BitcoinDepositObservation | null;
  mint: CanonicalDepositMint | null;
  providerTimedOut?: boolean;
}): SbtcDepositLifecycle {
  validateMetadata(input.metadata);
  const metadata = input.metadata;
  const gross = parseQuantity(metadata.amountSats);
  const maximumFee = parseQuantity(metadata.maxSignerFeeSats);
  const expectedMinimum = maximumFee >= gross ? 0n : gross - maximumFee;
  const warnings: string[] = [];
  if (input.providerTimedOut === true)
    warnings.push("Emily status read timed out; the existing transfer remains pending");
  if (input.bitcoin !== null && !input.bitcoin.canonical) warnings.push("Bitcoin observation is not canonical");

  const emilyMismatch = input.emily === null ? [] : emilyMatches(metadata, input.emily);
  if (emilyMismatch.length > 0) warnings.push(`Emily evidence mismatch: ${emilyMismatch.join(", ")}`);
  const mintMismatch = input.mint === null ? [] : mintMatches(metadata, input.mint, expectedMinimum);
  if (mintMismatch.length > 0) warnings.push(`Canonical mint mismatch: ${mintMismatch.join(", ")}`);

  const currentHeight = input.bitcoin?.tipHeight ?? null;
  const lockHeight = input.emily?.parameters.lockTime ?? null;
  const blocksRemaining =
    lockHeight === null || currentHeight === null ? null : Math.max(0, lockHeight - currentHeight);
  const reclaimAvailable = blocksRemaining === 0 && input.mint === null;

  let state: SbtcDepositState;
  if (mintMismatch.length > 0 || emilyMismatch.length > 0) state = "reconciliation_failed";
  else if (input.mint !== null) state = "reconciled";
  else if (input.emily?.status === "rbf") state = "replaced";
  else if (input.emily?.status === "failed") state = "failed";
  else if (reclaimAvailable) state = "reclaimable";
  else if (input.emily?.status === "confirmed") state = "mint_pending";
  else if (input.emily?.status === "accepted") state = "signer_processing";
  else if ((input.bitcoin?.confirmations ?? 0) > 0) state = "confirming";
  else state = "submitted";

  const minted = input.mint === null ? null : parseQuantity(input.mint.amountSats);
  const mintFee = minted === null || mintMismatch.length > 0 ? null : gross - minted;
  const fulfillmentFee =
    input.emily?.fulfillment === null || input.emily?.fulfillment === undefined
      ? null
      : parseQuantity(input.emily.fulfillment.btcFeeSats);
  if (mintFee !== null && fulfillmentFee !== null && mintFee !== fulfillmentFee) {
    warnings.push("Emily fulfillment fee does not match the canonical minted amount delta");
    state = "reconciliation_failed";
  }
  const actualFee = mintFee ?? fulfillmentFee;
  const complete = state === "reconciled";
  const nextAction =
    state === "reconciled"
      ? "COMPLETE"
      : state === "reclaimable"
        ? "RECLAIM"
        : state === "reconciliation_failed" || state === "failed" || state === "replaced"
          ? "CONTACT_SUPPORT"
          : "WAIT";

  return {
    transferId: sbtcDepositTransferId(metadata),
    state,
    complete,
    nextAction,
    broadcastAllowed: false,
    contracts: depositContracts(metadata.network),
    bitcoin: {
      txid: metadata.bitcoinTxid.toLowerCase(),
      outputIndex: metadata.bitcoinTxOutputIndex,
      confirmations: input.bitcoin?.confirmations ?? null,
      canonical: input.bitcoin?.canonical ?? null,
      source: input.bitcoin?.source ?? null,
    },
    signer: {
      status: input.emily?.status ?? null,
      message: input.emily?.statusMessage ?? null,
      lastUpdateHeight: input.emily?.lastUpdateHeight ?? null,
      lastUpdateBlockHash: input.emily?.lastUpdateBlockHash ?? null,
    },
    fees: {
      maximumSignerFeeSats: maximumFee.toString(10),
      actualSignerFeeSats: actualFee?.toString(10) ?? null,
    },
    output: {
      expectedMinimumSats: expectedMinimum.toString(10),
      mintedSats: minted?.toString(10) ?? null,
    },
    recovery: {
      reclaimScript: metadata.reclaimScript.toLowerCase(),
      lockHeight,
      currentBitcoinHeight: currentHeight,
      blocksRemaining,
      state: complete ? "consumed" : lockHeight === null ? "unavailable" : reclaimAvailable ? "available" : "locked",
    },
    mint: input.mint,
    warnings,
  };
}
