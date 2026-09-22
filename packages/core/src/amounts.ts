import { formatAssetId, parseAssetId, sameAsset, type AssetId } from "./ids.ts";

export type AssetAmount = {
  asset: AssetId;
  quantity: bigint;
};

const INTEGER = /^-?[0-9]+$/;

export function parseQuantity(value: string): bigint {
  const trimmed = value.trim();
  if (!INTEGER.test(trimmed)) {
    throw new Error(`Quantity must be a base-10 integer string, got ${JSON.stringify(value)}`);
  }
  return BigInt(trimmed);
}

export function formatQuantity(quantity: bigint): string {
  return quantity.toString(10);
}

export function jsonAmount(amount: AssetAmount): { asset: string; quantity: string } {
  return { asset: formatAssetId(amount.asset), quantity: formatQuantity(amount.quantity) };
}

export function parseAmount(value: { asset: string; quantity: unknown }): AssetAmount {
  if (typeof value.quantity === "number") {
    throw new Error("Quantity cannot use a JavaScript number");
  }
  if (typeof value.quantity !== "string") {
    throw new Error(`Quantity must be a base-10 integer string, got ${JSON.stringify(value.quantity)}`);
  }
  return { asset: parseAssetId(value.asset), quantity: parseQuantity(value.quantity) };
}

export function amount(asset: AssetId, quantity: string | bigint): AssetAmount {
  return { asset, quantity: typeof quantity === "bigint" ? quantity : parseQuantity(quantity) };
}

export function assertFinancialInt(value: unknown, label: string): bigint {
  if (typeof value === "number") {
    throw new Error(`${label} cannot use a JavaScript number`);
  }
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return parseQuantity(value);
  throw new Error(`${label} must be a bigint or base-10 integer string`);
}

export function addAmounts(left: AssetAmount, right: AssetAmount): AssetAmount {
  if (!sameAsset(left.asset, right.asset)) throw new Error("Cannot add amounts of different assets");
  return { asset: left.asset, quantity: left.quantity + right.quantity };
}

export function assertPositive(amount: AssetAmount, label: string): void {
  if (amount.quantity <= 0n) throw new Error(`${label} must be greater than zero`);
}

export type Rounding = "down" | "up";

export function mulDiv(value: bigint, numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const product = value * numerator;
  if (rounding === "down") return product / denominator;
  return (product + denominator - 1n) / denominator;
}

/**
 * Safely parses a human-entered decimal string into an exact integer bigint representation
 * with the specified decimal places, preventing floating-point precision loss.
 *
 * @example
 * parseUnits("1.5", 8) // 150000000n
 * parseUnits("0.00000001", 8) // 1n
 */
export function parseUnits(value: string, decimals: number | bigint): bigint {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) {
    throw new Error(`Decimals must be an integer between 0 and 36, got ${String(decimals)}`);
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "+") {
    throw new Error(`Invalid decimal string: ${JSON.stringify(value)}`);
  }

  if (/[eE]/.test(trimmed)) {
    throw new Error(`Scientific notation is forbidden for financial amounts: ${JSON.stringify(value)}`);
  }

  const isNegative = trimmed.startsWith("-");
  const unsigned = isNegative ? trimmed.slice(1) : trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;

  const parts = unsigned.split(".");
  if (parts.length > 2) {
    throw new Error(`Multiple decimal points in string: ${JSON.stringify(value)}`);
  }

  const [intPart = "", fracPart = ""] = parts;
  if (intPart === "" && fracPart === "") {
    throw new Error(`Invalid decimal string with no digits: ${JSON.stringify(value)}`);
  }
  if (!INTEGER.test(intPart) && intPart !== "") {
    throw new Error(`Invalid integer part in decimal string: ${JSON.stringify(value)}`);
  }
  if (fracPart !== "" && !INTEGER.test(fracPart)) {
    throw new Error(`Invalid fractional part in decimal string: ${JSON.stringify(value)}`);
  }

  if (fracPart.length > dec) {
    throw new Error(
      `Fractional component has ${fracPart.length} decimal places, exceeding allowed ${dec} decimals: ${JSON.stringify(value)}`,
    );
  }

  const paddedFrac = fracPart.padEnd(dec, "0");
  const normalizedInt = intPart === "" ? "0" : intPart;
  const combinedStr = `${normalizedInt}${paddedFrac}`;
  const parsed = BigInt(combinedStr);

  return isNegative && parsed !== 0n ? -parsed : parsed;
}

export type FormatUnitsOptions = {
  maxDecimals?: number;
  trimTrailingZeros?: boolean;
};

/**
 * Safely formats an exact integer bigint into a fixed-point decimal string representation
 * with the specified decimal places, preventing floating-point precision loss.
 *
 * @example
 * formatUnits(150000000n, 8) // "1.50000000"
 * formatUnits(150000000n, 8, { trimTrailingZeros: true }) // "1.5"
 */
export function formatUnits(
  quantity: bigint | string,
  decimals: number | bigint,
  options?: FormatUnitsOptions,
): string {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) {
    throw new Error(`Decimals must be an integer between 0 and 36, got ${String(decimals)}`);
  }

  const rawQty = typeof quantity === "bigint" ? quantity : parseQuantity(quantity);
  const isNegative = rawQty < 0n;
  const absQty = isNegative ? -rawQty : rawQty;

  if (dec === 0) {
    const res = absQty.toString(10);
    return isNegative && absQty !== 0n ? `-${res}` : res;
  }

  const str = absQty.toString(10).padStart(dec + 1, "0");
  const intPart = str.slice(0, -dec);
  let fracPart = str.slice(-dec);

  if (options?.maxDecimals !== undefined) {
    if (options.maxDecimals < 0) throw new Error("maxDecimals cannot be negative");
    fracPart = fracPart.slice(0, options.maxDecimals);
  }

  if (options?.trimTrailingZeros) {
    fracPart = fracPart.replace(/0+$/, "");
  }

  const formatted = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return isNegative && absQty !== 0n ? `-${formatted}` : formatted;
}

/**
 * JSON replacer function that converts native BigInt values to string to prevent JSON.stringify errors.
 */
export function safeBigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString(10) : value;
}

/**
 * Serializes data containing BigInts safely into JSON strings without throwing TypeError.
 */
export function serializeFinancialJson(value: unknown, space?: number | string): string {
  return JSON.stringify(value, safeBigIntReplacer, space);
}

/**
 * Parses financial JSON strings.
 */
export function parseFinancialJson<T = unknown>(json: string): T {
  return JSON.parse(json) as T;
}
