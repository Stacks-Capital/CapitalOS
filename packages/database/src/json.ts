import { type AssetAmount, jsonAmount } from "@stacks-capital/core";
import type postgres from "postgres";

/** Quantities are bigint in core and base-10 strings in the database, never JSON numbers (page 01). */
export function toJson(value: unknown): postgres.JSONValue {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === "object") {
    if ("asset" in value && "quantity" in value && typeof value.quantity === "bigint") {
      return jsonAmount(value as AssetAmount);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toJson(entry)]),
    );
  }
  return value as postgres.JSONValue;
}
