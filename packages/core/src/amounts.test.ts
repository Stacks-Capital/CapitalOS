import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAmounts,
  amount,
  assertFinancialInt,
  assertPositive,
  formatQuantity,
  formatUnits,
  jsonAmount,
  mulDiv,
  parseAmount,
  parseFinancialJson,
  parseQuantity,
  parseUnits,
  safeBigIntReplacer,
  serializeFinancialJson,
} from "./amounts.ts";
import { sip10, stacksNative } from "./ids.ts";

describe("amounts and financial serialization", () => {
  it("parses and formats base-10 quantities", () => {
    assert.equal(parseQuantity("1000"), 1000n);
    assert.equal(parseQuantity("-500"), -500n);
    assert.equal(formatQuantity(1000n), "1000");
    assert.throws(() => parseQuantity("10.5"));
    assert.throws(() => parseQuantity("1e5"));
  });

  describe("parseUnits", () => {
    it("parses integers with 0 decimals", () => {
      assert.equal(parseUnits("42", 0), 42n);
      assert.equal(parseUnits("-42", 0), -42n);
      assert.equal(parseUnits("0", 0), 0n);
    });

    it("parses USDCx 6-decimal amounts", () => {
      assert.equal(parseUnits("1.5", 6), 1500000n);
      assert.equal(parseUnits("0.000001", 6), 1n);
      assert.equal(parseUnits("100", 6), 100000000n);
      assert.equal(parseUnits("0", 6), 0n);
      assert.equal(parseUnits("-2.25", 6), -2250000n);
    });

    it("parses sBTC 8-decimal amounts", () => {
      assert.equal(parseUnits("1.00000000", 8), 100000000n);
      assert.equal(parseUnits("0.00000001", 8), 1n);
      assert.equal(parseUnits("0.5", 8), 50000000n);
      assert.equal(parseUnits("21000000", 8), 2100000000000000n);
    });

    it("parses 18-decimal amounts", () => {
      assert.equal(parseUnits("1.0", 18), 1000000000000000000n);
      assert.equal(parseUnits("0.000000000000000001", 18), 1n);
    });

    it("rejects scientific notation", () => {
      assert.throws(() => parseUnits("1e6", 6), /scientific notation is forbidden/i);
      assert.throws(() => parseUnits("1.5E-3", 6), /scientific notation is forbidden/i);
    });

    it("rejects fractional precision exceeding decimals", () => {
      assert.throws(() => parseUnits("1.1234567", 6), /exceeding allowed 6 decimals/i);
      assert.throws(() => parseUnits("0.000000001", 8), /exceeding allowed 8 decimals/i);
    });

    it("rejects invalid inputs", () => {
      assert.throws(() => parseUnits("", 6));
      assert.throws(() => parseUnits(".", 6));
      assert.throws(() => parseUnits("1.2.3", 6));
      assert.throws(() => parseUnits("abc", 6));
      assert.throws(() => parseUnits("10", -1));
      assert.throws(() => parseUnits("10", 37));
    });
  });

  describe("formatUnits", () => {
    it("formats 0 decimals", () => {
      assert.equal(formatUnits(42n, 0), "42");
      assert.equal(formatUnits(-42n, 0), "-42");
    });

    it("formats 6-decimal USDCx amounts", () => {
      assert.equal(formatUnits(1500000n, 6), "1.500000");
      assert.equal(formatUnits(1500000n, 6, { trimTrailingZeros: true }), "1.5");
      assert.equal(formatUnits(1n, 6), "0.000001");
      assert.equal(formatUnits(0n, 6), "0.000000");
      assert.equal(formatUnits(0n, 6, { trimTrailingZeros: true }), "0");
      assert.equal(formatUnits(-2250000n, 6, { trimTrailingZeros: true }), "-2.25");
    });

    it("formats 8-decimal sBTC amounts", () => {
      assert.equal(formatUnits(100000000n, 8), "1.00000000");
      assert.equal(formatUnits(100000000n, 8, { trimTrailingZeros: true }), "1");
      assert.equal(formatUnits(50000000n, 8, { trimTrailingZeros: true }), "0.5");
      assert.equal(formatUnits(1n, 8), "0.00000001");
    });

    it("formats with maxDecimals option", () => {
      assert.equal(formatUnits(1234567n, 6, { maxDecimals: 2 }), "1.23");
      assert.equal(formatUnits(1200000n, 6, { maxDecimals: 4, trimTrailingZeros: true }), "1.2");
    });

    it("accepts string quantities", () => {
      assert.equal(formatUnits("1500000", 6, { trimTrailingZeros: true }), "1.5");
    });
  });

  describe("safe BigInt JSON serialization", () => {
    it("serializes BigInt fields to decimal strings", () => {
      const data = {
        amount: 150000000n,
        meta: { balance: 999999999999999999n },
        label: "test",
      };
      const json = serializeFinancialJson(data);
      assert.equal(json, '{"amount":"150000000","meta":{"balance":"999999999999999999"},"label":"test"}');

      const parsed = parseFinancialJson<{ amount: string; meta: { balance: string }; label: string }>(json);
      assert.equal(parsed.amount, "150000000");
      assert.equal(parsed.meta.balance, "999999999999999999");
      assert.equal(parsed.label, "test");
    });

    it("safeBigIntReplacer converts bigints", () => {
      assert.equal(safeBigIntReplacer("val", 42n), "42");
      assert.equal(safeBigIntReplacer("val", "hello"), "hello");
      assert.equal(safeBigIntReplacer("val", 10), 10);
    });
  });

  describe("amounts helpers", () => {
    const asset = stacksNative("mainnet");
    it("handles jsonAmount and parseAmount", () => {
      const a = amount(asset, 500n);
      const j = jsonAmount(a);
      assert.equal(j.quantity, "500");
      const p = parseAmount(j);
      assert.equal(p.quantity, 500n);
    });

    it("adds amounts for identical asset", () => {
      const a = amount(asset, 100n);
      const b = amount(asset, 200n);
      assert.equal(addAmounts(a, b).quantity, 300n);
    });

    it("rejects adding amounts for different assets", () => {
      const a = amount(asset, 100n);
      const token = sip10("mainnet", "SP000.token", "token");
      const b = amount(token, 200n);
      assert.throws(() => addAmounts(a, b), /different assets/);
    });

    it("mulDiv handles down and up rounding", () => {
      assert.equal(mulDiv(10n, 3n, 2n, "down"), 15n);
      assert.equal(mulDiv(10n, 1n, 3n, "down"), 3n);
      assert.equal(mulDiv(10n, 1n, 3n, "up"), 4n);
      assert.throws(() => mulDiv(10n, 1n, 0n, "down"), /Division by zero/);
    });

    it("assertPositive throws on non-positive amounts", () => {
      assert.throws(() => assertPositive(amount(asset, 0n), "test"));
      assert.throws(() => assertPositive(amount(asset, -10n), "test"));
      assert.doesNotThrow(() => assertPositive(amount(asset, 10n), "test"));
    });

    it("assertFinancialInt validates bigint or numeric string", () => {
      assert.equal(assertFinancialInt(100n, "val"), 100n);
      assert.equal(assertFinancialInt("100", "val"), 100n);
      assert.throws(() => assertFinancialInt(100, "val"), /cannot use a JavaScript number/);
      assert.throws(() => assertFinancialInt("abc", "val"));
    });
  });
});
