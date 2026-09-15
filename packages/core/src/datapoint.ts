export type DataPoint<T> = {
  value: T | null;
  observedAt: string;
  source: string;
  stale: boolean;
  warnings: string[];
  blockHeight?: number;
  blockHash?: string;
};

export function dataPoint<T>(
  value: T | null,
  source: string,
  extras: { observedAt?: string; stale?: boolean; warnings?: string[]; blockHeight?: number; blockHash?: string } = {},
): DataPoint<T> {
  const point: DataPoint<T> = {
    value,
    observedAt: extras.observedAt ?? new Date().toISOString(),
    source,
    stale: extras.stale ?? false,
    warnings: extras.warnings ?? [],
  };
  if (extras.blockHeight !== undefined) point.blockHeight = extras.blockHeight;
  if (extras.blockHash !== undefined) point.blockHash = extras.blockHash;
  return point;
}

export function unknownPoint<T>(source: string, warning: string): DataPoint<T> {
  return dataPoint<T>(null, source, { stale: true, warnings: [warning] });
}

export function requireFresh<T>(point: DataPoint<T>, label: string): T {
  if (point.value === null || point.stale) {
    throw Object.assign(new Error(`${label} is stale or unknown`), { code: "ORACLE_STALE" });
  }
  return point.value;
}
