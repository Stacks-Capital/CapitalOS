import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketAssets } from "@stacks-capital/database";
import { decodePositions, normalizeTimestamp, rewardSnapshot } from "./positions.ts";

const OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
const SBTC = "stacks:mainnet:contract:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token:sbtc-token";
const ZFT = "stacks:mainnet:contract:SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc:zft";
const AT = new Date("2026-09-18T12:00:00.000Z");
const BLOCK = { height: 9012515, hash: "0xaa" };

const VAULT: MarketAssets = {
  marketId: "zest.sbtc.vault",
  deploymentId: "zest:mainnet:SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc@6162063",
  suppliedAssetId: SBTC,
  receiptAssetId: ZFT,
  adapterVersion: "zest-earn@0.1.0",
};

const CREDIT: MarketAssets = {
  marketId: "granite.sbtc.isolated",
  deploymentId: "granite:mainnet:SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market@8883545",
  suppliedAssetId: SBTC,
  receiptAssetId: null,
  adapterVersion: "granite-credit@0.1.0",
};

const provenance = (extra: Partial<{ stale: boolean; warnings: string[] }> = {}) => ({
  stale: extra.stale ?? false,
  warnings: extra.warnings ?? [],
  observedAt: AT,
  block: BLOCK,
});

const decode = (
  positions: { marketId: string; kind: string; quantity: string }[],
  options: {
    underlying?: string | null;
    hadRead?: (position: { kind: string }) => boolean;
    markets?: MarketAssets[];
    stale?: boolean;
  } = {},
) =>
  decodePositions({
    network: "mainnet",
    positions: positions.map((position) => ({ ...position, owner: OWNER })),
    markets: options.markets ?? [VAULT, CREDIT],
    reads: { underlyingFor: () => options.underlying ?? null },
    provenance: provenance({ stale: options.stale ?? false }),
    hadRead: options.hadRead ?? (() => true),
  });

describe("normalising both protocols", () => {
  it("converts a vault receipt balance into what it is worth", () => {
    const [row] = decode([{ marketId: "zest.sbtc.vault", kind: "supplied", quantity: "100000000" }], {
      underlying: "100054938",
    });
    assert.equal(row?.kind, "supplied");
    // The wallet holds shares; the position is stored in sBTC, which is what the shares are worth.
    assert.equal(row?.assetId, SBTC);
    assert.equal(row?.quantity, "100054938");
    assert.equal(row?.stale, false);
    assert.deepEqual(row?.warnings, []);
  });

  it("keeps a receipt in receipt units when the share rate cannot be read, and says so", () => {
    const [row] = decode([{ marketId: "zest.sbtc.vault", kind: "supplied", quantity: "100000000" }], {
      underlying: null,
    });
    assert.equal(row?.assetId, ZFT);
    assert.equal(row?.quantity, "100000000");
    assert.match(row?.warnings.join(" ") ?? "", /receipt units; the share rate was unavailable/);
  });

  it("records collateral and debt from a credit market against the same asset", () => {
    const rows = decode([
      { marketId: "granite.sbtc.isolated", kind: "collateral", quantity: "5000000" },
      { marketId: "granite.sbtc.isolated", kind: "debt", quantity: "1000000" },
    ]);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.assetId, row.quantity]),
      [
        ["collateral", SBTC, "5000000"],
        ["debt", SBTC, "1000000"],
      ],
    );
    // Two positions in one market stay apart.
    assert.notEqual(rows[0]?.protocolKey, rows[1]?.protocolKey);
  });

  it("carries the deployment, adapter version and block of each market", () => {
    const rows = decode([
      { marketId: "zest.sbtc.vault", kind: "supplied", quantity: "1" },
      { marketId: "granite.sbtc.isolated", kind: "debt", quantity: "1" },
    ]);
    assert.deepEqual(
      rows.map((row) => [row.deploymentId, row.adapterVersion, row.blockHeight]),
      [
        [VAULT.deploymentId, "zest-earn@0.1.0", 9012515],
        [CREDIT.deploymentId, "granite-credit@0.1.0", 9012515],
      ],
    );
  });
});

describe("unknown is never zero", () => {
  it("stores a position the adapter defaulted to zero as unknown", () => {
    const [row] = decode([{ marketId: "granite.sbtc.isolated", kind: "debt", quantity: "0" }], {
      hadRead: () => false,
    });
    assert.equal(row?.quantity, null);
    assert.equal(row?.stale, true);
    assert.match(row?.warnings.join(" ") ?? "", /was not read, so it is unknown/);
  });

  it("keeps a real zero as zero", () => {
    const [row] = decode([{ marketId: "granite.sbtc.isolated", kind: "debt", quantity: "0" }]);
    assert.equal(row?.quantity, "0");
    assert.equal(row?.stale, false);
  });

  it("does not guess an unfamiliar position kind", () => {
    const [row] = decode([{ marketId: "zest.sbtc.vault", kind: "rehypothecated", quantity: "5" }]);
    assert.equal(row?.quantity, null);
    assert.match(row?.warnings.join(" ") ?? "", /unknown position kind: rehypothecated/);
  });

  it("skips a market the registry does not list", () => {
    assert.deepEqual(decode([{ marketId: "nope.market", kind: "supplied", quantity: "1" }]), []);
  });

  it("passes provider staleness through to every row", () => {
    const rows = decode([{ marketId: "granite.sbtc.isolated", kind: "collateral", quantity: "1" }], { stale: true });
    assert.equal(rows[0]?.stale, true);
  });
});

describe("reward timestamps", () => {
  it("reads seconds and milliseconds as the same instant", () => {
    assert.deepEqual(normalizeTimestamp(1789718028n, "seconds"), new Date("2026-09-18T07:53:48.000Z"));
    assert.deepEqual(normalizeTimestamp(1789718028000, "milliseconds"), new Date("2026-09-18T07:53:48.000Z"));
    assert.equal(normalizeTimestamp(0n, "seconds"), null);
    assert.equal(normalizeTimestamp(null, "seconds"), null);
    assert.equal(normalizeTimestamp(Number.NaN, "milliseconds"), null);
  });

  it("stores a rate with the time its source last updated it", () => {
    const row = rewardSnapshot(
      "mainnet",
      { marketId: VAULT.marketId, adapterVersion: VAULT.adapterVersion, rate: 130n, updatedAtSeconds: 1789718028n },
      VAULT.marketId,
      VAULT.adapterVersion,
      new Date("2026-09-18T10:00:00.000Z"),
      BLOCK,
    );
    assert.deepEqual([row.rate, row.rateScale, row.stale, row.warnings], ["130", 4, false, []]);
    assert.deepEqual(row.updatedAt, new Date("2026-09-18T07:53:48.000Z"));
  });

  it("marks a rate stale when its source has not updated for a day", () => {
    const row = rewardSnapshot(
      "mainnet",
      { marketId: VAULT.marketId, adapterVersion: VAULT.adapterVersion, rate: 130n, updatedAtSeconds: 1789718028n },
      VAULT.marketId,
      VAULT.adapterVersion,
      new Date("2026-09-20T10:00:00.000Z"),
      BLOCK,
    );
    assert.equal(row.stale, true);
    assert.match(row.warnings.join(" "), /last updated \d+ hours ago/);
  });

  it("stores an unreadable rate as unknown, with the reason", () => {
    const failed = rewardSnapshot("mainnet", new Error("HTTP 503"), VAULT.marketId, VAULT.adapterVersion, AT, BLOCK);
    assert.equal(failed.rate, null);
    assert.equal(failed.stale, true);
    assert.match(failed.warnings.join(" "), /reward read failed: HTTP 503/);

    const missing = rewardSnapshot(
      "mainnet",
      { marketId: VAULT.marketId, adapterVersion: VAULT.adapterVersion, rate: null, updatedAtSeconds: null },
      VAULT.marketId,
      VAULT.adapterVersion,
      AT,
      BLOCK,
    );
    assert.equal(missing.rate, null);
    assert.deepEqual(missing.warnings, [
      "zest.sbtc.vault reward rate is unknown",
      "zest.sbtc.vault did not report when its rate was last updated",
    ]);
  });
});
