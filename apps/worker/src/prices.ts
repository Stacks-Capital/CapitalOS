import type { NetworkName, PriceSnapshotRow } from "@stacks-capital/database";
import { type Hiro, decodeTuple, tupleUint } from "./hiro.ts";
import { encodeAscii } from "./clarity.ts";

// Granite's live market reads prices from this contract, so we read the same values it does (I06 finding).
// It is free through Hiro and needs no key, unlike Pyth Hermes.
export const DIA_ORACLE = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle";
export const PRICE_SOURCE = "dia-oracle";
export const PRICE_SCALE = 8;
export const PRICE_MAX_AGE_MS = 30 * 60 * 1000;
export const PRICE_FEEDS = ["BTC/USD", "STX/USD", "sBTC/USD"] as const;

export type OracleReading = { price: bigint | null; publishedAt: Date | null };

function describeAge(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

// A price of zero, an unset timestamp or a failed read is unknown, and unknown is stored as null with a warning.
export function priceSnapshot(
  network: NetworkName,
  feedKey: string,
  reading: OracleReading | Error,
  at: Date,
  maxAgeMs = PRICE_MAX_AGE_MS,
): PriceSnapshotRow {
  const base = {
    network,
    feedKey,
    priceScale: PRICE_SCALE,
    source: PRICE_SOURCE,
    observedAt: at,
    blockHeight: null,
    blockHash: null,
  };

  if (reading instanceof Error) {
    return {
      ...base,
      price: null,
      publishedAt: null,
      stale: true,
      warnings: [`${feedKey} read failed: ${reading.message}`],
    };
  }
  if (reading.price === null || reading.price <= 0n || reading.publishedAt === null) {
    return {
      ...base,
      price: null,
      publishedAt: null,
      stale: true,
      warnings: [`${feedKey} has no price in ${PRICE_SOURCE}`],
    };
  }

  const ageMs = at.getTime() - reading.publishedAt.getTime();
  const stale = ageMs > maxAgeMs;
  return {
    ...base,
    price: reading.price.toString(10),
    publishedAt: reading.publishedAt,
    stale,
    warnings: stale ? [`${feedKey} was published ${describeAge(ageMs)} ago`] : [],
  };
}

export async function readOracle(hiro: Hiro, feedKey: string, sender: string): Promise<OracleReading> {
  const hex = await hiro.callRead(DIA_ORACLE, "get-value", [encodeAscii(feedKey)], sender);
  const tuple = decodeTuple(hex);
  const price = tupleUint(tuple, "value");
  const timestampMs = tupleUint(tuple, "timestamp");
  return {
    price,
    publishedAt: timestampMs === null || timestampMs === 0n ? null : new Date(Number(timestampMs)),
  };
}

export async function readPrices(
  hiro: Hiro,
  input: { network: NetworkName; sender: string; at: Date; feeds?: readonly string[] },
): Promise<PriceSnapshotRow[]> {
  const rows: PriceSnapshotRow[] = [];
  for (const feedKey of input.feeds ?? PRICE_FEEDS) {
    const reading = await readOracle(hiro, feedKey, input.sender).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    rows.push(priceSnapshot(input.network, feedKey, reading, input.at));
  }
  return rows;
}
