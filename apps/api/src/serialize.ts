import type { z } from "@hono/zod-openapi";
import { type AssetAmount, jsonAmount, type Plan, type Quote } from "@stacks-capital/core";
import type { Plan as PlanSchema, Quote as QuoteSchema } from "./schemas.ts";

// Core holds quantities as bigint and assets as structures. The wire holds both as strings (page 01).
function wire(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object") {
    if ("asset" in value && "quantity" in value && typeof value.quantity === "bigint") {
      return jsonAmount(value as AssetAmount);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, wire(entry)]),
    );
  }
  return value;
}

export function serializeQuote(quote: Quote): z.infer<typeof QuoteSchema> {
  return wire(quote) as z.infer<typeof QuoteSchema>;
}

export function serializePlan(plan: Plan): z.infer<typeof PlanSchema> {
  return wire(plan) as z.infer<typeof PlanSchema>;
}
