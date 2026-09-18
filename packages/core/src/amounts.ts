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

export function parseAmount(value: { asset: string; quantity: string }): AssetAmount {
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
