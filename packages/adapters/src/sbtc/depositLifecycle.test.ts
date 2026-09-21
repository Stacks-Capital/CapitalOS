import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEmilyDepositNotification,
  evaluateSbtcDeposit,
  fetchEmilyDeposit,
  parseEmilyDeposit,
  type EmilyDeposit,
  type SbtcDepositMetadata,
} from "./depositLifecycle.ts";

const TXID = "11".repeat(32);
const metadata: SbtcDepositMetadata = {
  network: "mainnet",
  bitcoinTxid: TXID,
  bitcoinTxOutputIndex: 2,
  transactionHex: "0102",
  depositScript: "aabb",
  reclaimScript: "ccdd",
  recipient: "SP000000000000000000002Q6VF78",
  amountSats: "100000",
  maxSignerFeeSats: "1000",
};

const emily: EmilyDeposit = {
  bitcoinTxid: TXID,
  bitcoinTxOutputIndex: 2,
  recipient: metadata.recipient,
  amount: "100000",
  lastUpdateHeight: 9000000,
  lastUpdateBlockHash: `0x${"22".repeat(32)}`,
  status: "accepted",
  statusMessage: "accepted by signer quorum",
  parameters: { lockTime: 850144, maxFee: "1000" },
  reclaimScript: "ccdd",
  depositScript: "aabb",
  fulfillment: null,
  replacedByTx: null,
};

describe("K25 sBTC deposit lifecycle", () => {
  it("builds exactly the public Emily notification payload", () => {
    assert.deepEqual(createEmilyDepositNotification(metadata), {
      bitcoinTxid: TXID,
      bitcoinTxOutputIndex: 2,
      reclaimScript: "ccdd",
      depositScript: "aabb",
      transactionHex: "0102",
    });
  });

  it("exposes confirmations, signer state, maximum fee and locked recovery", () => {
    const lifecycle = evaluateSbtcDeposit({
      metadata,
      emily,
      bitcoin: { confirmations: 3, tipHeight: 850100, canonical: true, source: "bitcoin-core" },
      mint: null,
    });
    assert.equal(lifecycle.state, "signer_processing");
    assert.equal(lifecycle.bitcoin.confirmations, 3);
    assert.equal(lifecycle.signer.status, "accepted");
    assert.deepEqual(lifecycle.fees, { maximumSignerFeeSats: "1000", actualSignerFeeSats: null });
    assert.deepEqual(lifecycle.recovery, {
      reclaimScript: "ccdd",
      lockHeight: 850144,
      currentBitcoinHeight: 850100,
      blocksRemaining: 44,
      state: "locked",
    });
    assert.equal(lifecycle.broadcastAllowed, false);
  });

  it("requires a matching canonical mint before completion and calculates the actual signer fee", () => {
    const lifecycle = evaluateSbtcDeposit({
      metadata,
      emily: { ...emily, status: "confirmed", statusMessage: "mint observed" },
      bitcoin: { confirmations: 7, tipHeight: 850120, canonical: true, source: "bitcoin-core" },
      mint: {
        bitcoinTxid: TXID,
        bitcoinTxOutputIndex: 2,
        amountSats: "99500",
        recipient: metadata.recipient,
        stacksTxid: `0x${"33".repeat(32)}`,
        blockHeight: 9000001,
        blockHash: `0x${"44".repeat(32)}`,
        canonical: true,
      },
    });
    assert.equal(lifecycle.state, "reconciled");
    assert.equal(lifecycle.complete, true);
    assert.equal(lifecycle.fees.actualSignerFeeSats, "500");
    assert.equal(lifecycle.output.mintedSats, "99500");
    assert.equal(lifecycle.recovery.state, "consumed");
    assert.match(lifecycle.contracts.deposit, /\.sbtc-deposit$/);
  });

  it("fails closed when the canonical mint is for a different output or amount", () => {
    const lifecycle = evaluateSbtcDeposit({
      metadata,
      emily,
      bitcoin: { confirmations: 10, tipHeight: 850120, canonical: true, source: "bitcoin-core" },
      mint: {
        bitcoinTxid: TXID,
        bitcoinTxOutputIndex: 0,
        amountSats: "98000",
        recipient: metadata.recipient,
        stacksTxid: `0x${"33".repeat(32)}`,
        blockHeight: 9000001,
        blockHash: `0x${"44".repeat(32)}`,
        canonical: true,
      },
    });
    assert.equal(lifecycle.state, "reconciliation_failed");
    assert.equal(lifecycle.complete, false);
    assert.equal(lifecycle.fees.actualSignerFeeSats, null);
    assert.match(lifecycle.warnings.join(" "), /output index.*fee bound/);
  });

  it("makes a matured reclaim explicit", () => {
    const lifecycle = evaluateSbtcDeposit({
      metadata,
      emily: { ...emily, status: "pending", statusMessage: "pending" },
      bitcoin: { confirmations: 144, tipHeight: 850144, canonical: true, source: "bitcoin-core" },
      mint: null,
    });
    assert.equal(lifecycle.state, "reclaimable");
    assert.equal(lifecycle.nextAction, "RECLAIM");
    assert.equal(lifecycle.recovery.state, "available");
  });

  it("does not authorize a second transfer when Emily times out", () => {
    const first = evaluateSbtcDeposit({ metadata, emily: null, bitcoin: null, mint: null, providerTimedOut: true });
    const retry = evaluateSbtcDeposit({ metadata, emily: null, bitcoin: null, mint: null, providerTimedOut: true });
    assert.equal(first.transferId, retry.transferId);
    assert.equal(first.broadcastAllowed, false);
    assert.equal(retry.broadcastAllowed, false);
    assert.equal(retry.nextAction, "WAIT");
    assert.match(retry.warnings.join(" "), /existing transfer remains pending/);
  });

  it("accepts a protocol fee cap larger than the deposit without claiming a negative output", () => {
    const lifecycle = evaluateSbtcDeposit({
      metadata: { ...metadata, maxSignerFeeSats: "80000", amountSats: "55000" },
      emily: { ...emily, amount: "55000", parameters: { ...emily.parameters, maxFee: "80000" } },
      bitcoin: { confirmations: 1, tipHeight: 850100, canonical: true, source: "bitcoin-core" },
      mint: null,
    });
    assert.equal(lifecycle.output.expectedMinimumSats, "0");
    assert.equal(lifecycle.fees.maximumSignerFeeSats, "80000");
    assert.equal(lifecycle.state, "signer_processing");
  });

  it("reads the exact txid and vout endpoint and validates the response schema", async () => {
    let requested = "";
    const result = await fetchEmilyDeposit({
      network: "mainnet",
      bitcoinTxid: TXID,
      bitcoinTxOutputIndex: 2,
      fetch: async (url) => {
        requested = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...emily, amount: 100000, parameters: { ...emily.parameters, maxFee: 1000 } }),
        };
      },
    });
    assert.equal(requested, `https://sbtc-emily.com/deposit/${TXID}/2`);
    assert.equal(result?.amount, "100000");
    assert.equal(result?.parameters.maxFee, "1000");
    assert.throws(() => parseEmilyDeposit({ ...emily, status: "complete" }), /Unsupported Emily deposit status/);
  });

  it("normalizes Emily's case-sensitive fulfillment fields without inventing aliases", () => {
    const parsed = parseEmilyDeposit({
      ...emily,
      fulfillment: {
        BitcoinTxid: "55".repeat(32),
        BitcoinTxIndex: 1,
        StacksTxid: `0x${"66".repeat(32)}`,
        BitcoinBlockHash: "77".repeat(32),
        BitcoinBlockHeight: 850101,
        BtcFee: 500,
      },
    });
    assert.deepEqual(parsed.fulfillment, {
      bitcoinTxid: "55".repeat(32),
      bitcoinTxOutputIndex: 1,
      stacksTxid: `0x${"66".repeat(32)}`,
      bitcoinBlockHash: "77".repeat(32),
      bitcoinBlockHeight: 850101,
      btcFeeSats: "500",
    });
  });
});
