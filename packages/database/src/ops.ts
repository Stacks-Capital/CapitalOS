import type { Sql } from "./lib.ts";
import type { NetworkName } from "./registry.ts";

export type OpsEventKind = "quote_succeeded" | "quote_failed" | "ingestion_tick" | "ingestion_failed";

export type OpsEvent = {
  kind: OpsEventKind;
  network: NetworkName;
  subject: string;
  code?: string | null;
  value?: bigint | number | null;
  at: Date;
};

export async function recordOpsEvent(sql: Sql, event: OpsEvent): Promise<void> {
  await sql`
    INSERT INTO ops_events (kind, network, subject, code, value, at)
    VALUES (${event.kind}, ${event.network}, ${event.subject}, ${event.code ?? null},
            ${event.value === undefined || event.value === null ? null : String(event.value)}, ${event.at})
  `;
}

export type IngestionHealth = {
  checkpointHeight: number | null;
  checkpointHash: string | null;
  checkpointAt: Date | null;
  /** Blocks behind the tip at the last successful tick. Null when no tick has run. */
  blocksBehind: number | null;
  lastTickAt: Date | null;
  failuresInWindow: number;
};

export type QuoteHealth = { subject: string; attempts: number; failures: number; codes: Record<string, number> };

export type StuckWorkflow = { id: string; state: string; nextAction: string; updatedAt: Date; ageSeconds: number };

export type MetricsSnapshot = {
  network: NetworkName;
  at: Date;
  ingestion: IngestionHealth;
  quotes: QuoteHealth[];
  stuck: StuckWorkflow[];
};

/** How long a workflow may sit in each state before it counts as stuck. */
export type StuckThresholds = Record<string, number>;

export const DEFAULT_STUCK_SECONDS: StuckThresholds = {
  // A wallet that has not answered in half an hour has been abandoned or is lost.
  AWAITING_SIGNATURE: 30 * 60,
  SUBMITTED: 60 * 60,
  CONFIRMING: 60 * 60,
  RECONCILING: 60 * 60,
  // Nothing about an unknown broadcast resolves itself, so it is stuck at once.
  BROADCAST_UNKNOWN: 0,
  REORGED: 0,
  MANUAL_REVIEW: 0,
};

/** Everything an operator needs to know is wrong, computed from the database so every instance agrees. */
export async function metricsSnapshot(
  sql: Sql,
  input: { network: NetworkName; at: Date; windowSeconds: number; stuckSeconds?: StuckThresholds },
): Promise<MetricsSnapshot> {
  const since = new Date(input.at.getTime() - input.windowSeconds * 1000);
  const stuckSeconds = input.stuckSeconds ?? DEFAULT_STUCK_SECONDS;

  const [checkpoint] = await sql<{ height: number; hash: string; updatedAt: Date }[]>`
    SELECT height::int, hash, updated_at AS "updatedAt" FROM ingestion_checkpoints
    WHERE chain = 'stacks' AND network = ${input.network}
  `;
  const [tick] = await sql<{ value: string | null; at: Date }[]>`
    SELECT value::text, at FROM ops_events
    WHERE network = ${input.network} AND kind = 'ingestion_tick'
    ORDER BY at DESC, id DESC LIMIT 1
  `;
  const [failures] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ops_events
    WHERE network = ${input.network} AND kind = 'ingestion_failed' AND at > ${since}
  `;

  const quoteRows = await sql<{ subject: string; kind: string; code: string | null; count: number }[]>`
    SELECT subject, kind, code, count(*)::int AS count FROM ops_events
    WHERE network = ${input.network} AND kind IN ('quote_succeeded', 'quote_failed') AND at > ${since}
    GROUP BY subject, kind, code
  `;
  const quotes = new Map<string, QuoteHealth>();
  for (const row of quoteRows) {
    const health = quotes.get(row.subject) ?? { subject: row.subject, attempts: 0, failures: 0, codes: {} };
    health.attempts += row.count;
    if (row.kind === "quote_failed") {
      health.failures += row.count;
      const code = row.code ?? "UNCLASSIFIED";
      health.codes[code] = (health.codes[code] ?? 0) + row.count;
    }
    quotes.set(row.subject, health);
  }

  const states = Object.keys(stuckSeconds);
  const candidates = await sql<{ id: string; state: string; nextAction: string; updatedAt: Date }[]>`
    SELECT id, state, next_action AS "nextAction", updated_at AS "updatedAt" FROM workflows
    WHERE network = ${input.network} AND state = ANY(${sql.array(states)})
    ORDER BY updated_at
  `;
  const stuck = candidates
    .map((row) => ({ ...row, ageSeconds: Math.floor((input.at.getTime() - row.updatedAt.getTime()) / 1000) }))
    .filter((row) => row.ageSeconds >= (stuckSeconds[row.state] ?? Number.POSITIVE_INFINITY));

  return {
    network: input.network,
    at: input.at,
    ingestion: {
      checkpointHeight: checkpoint?.height ?? null,
      checkpointHash: checkpoint?.hash ?? null,
      checkpointAt: checkpoint?.updatedAt ?? null,
      blocksBehind: tick?.value === null || tick === undefined ? null : Number(tick.value),
      lastTickAt: tick?.at ?? null,
      failuresInWindow: failures?.count ?? 0,
    },
    quotes: [...quotes.values()].sort((left, right) => left.subject.localeCompare(right.subject)),
    stuck,
  };
}

export type AlertKind = "ingestion_lag" | "ingestion_failing" | "quote_failures" | "workflow_stuck";

export type AlertRow = {
  id: number;
  dedupeKey: string;
  kind: AlertKind;
  severity: "warning" | "critical";
  network: NetworkName;
  subject: string;
  message: string;
  firstSeen: Date;
  lastSeen: Date;
  occurrences: number;
  resolvedAt: Date | null;
};

export async function openAlerts(sql: Sql, network: NetworkName): Promise<AlertRow[]> {
  return sql<AlertRow[]>`
    SELECT id::int, dedupe_key AS "dedupeKey", kind, severity, network, subject, message, first_seen AS "firstSeen",
           last_seen AS "lastSeen", occurrences, resolved_at AS "resolvedAt"
    FROM alerts WHERE network = ${network} AND resolved_at IS NULL ORDER BY first_seen
  `;
}

export type AlertInput = {
  dedupeKey: string;
  kind: AlertKind;
  severity: "warning" | "critical";
  network: NetworkName;
  subject: string;
  message: string;
};

/**
 * Opens an alert, or updates the one already open for the same key. Returns true only when it opened,
 * which is the only time anyone should be notified.
 */
export async function raiseAlert(sql: Sql, alert: AlertInput, at: Date): Promise<boolean> {
  const updated = await sql`
    UPDATE alerts SET last_seen = ${at}, occurrences = occurrences + 1, message = ${alert.message},
                      severity = ${alert.severity}
    WHERE dedupe_key = ${alert.dedupeKey} AND resolved_at IS NULL
  `;
  if (updated.count > 0) return false;
  const inserted = await sql`
    INSERT INTO alerts (dedupe_key, kind, severity, network, subject, message, first_seen, last_seen)
    VALUES (${alert.dedupeKey}, ${alert.kind}, ${alert.severity}, ${alert.network}, ${alert.subject},
            ${alert.message}, ${at}, ${at})
    ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL DO NOTHING
  `;
  return inserted.count > 0;
}

export async function resolveAlert(sql: Sql, dedupeKey: string, at: Date): Promise<boolean> {
  const result = await sql`
    UPDATE alerts SET resolved_at = ${at} WHERE dedupe_key = ${dedupeKey} AND resolved_at IS NULL
  `;
  return result.count > 0;
}

export type CapabilityOverride = {
  network: NetworkName;
  marketId: string;
  action: string;
  state: "paused" | "disabled";
  reason: string;
  setBy: string;
  setAt: Date;
};

export async function setCapabilityOverride(sql: Sql, override: CapabilityOverride): Promise<void> {
  await sql`
    INSERT INTO capability_overrides (network, market_id, action, state, reason, set_by, set_at)
    VALUES (${override.network}, ${override.marketId}, ${override.action}, ${override.state}, ${override.reason},
            ${override.setBy}, ${override.setAt})
    ON CONFLICT (network, market_id, action) DO UPDATE
      SET state = EXCLUDED.state, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
  `;
}

export async function clearCapabilityOverride(
  sql: Sql,
  input: { network: NetworkName; marketId: string; action: string },
): Promise<boolean> {
  const result = await sql`
    DELETE FROM capability_overrides
    WHERE network = ${input.network} AND market_id = ${input.marketId} AND action = ${input.action}
  `;
  return result.count > 0;
}

export async function listCapabilityOverrides(sql: Sql, network: NetworkName): Promise<CapabilityOverride[]> {
  return sql<CapabilityOverride[]>`
    SELECT network, market_id AS "marketId", action, state, reason, set_by AS "setBy", set_at AS "setAt"
    FROM capability_overrides WHERE network = ${network} ORDER BY market_id, action
  `;
}

/** What a caller may do right now, after operator switches. Null when the registry lists no such action. */
export async function effectiveCapability(
  sql: Sql,
  input: { network: NetworkName; marketId: string; action: string },
): Promise<{ state: string; reason: string; overridden: boolean } | null> {
  const [row] = await sql<{ state: string; reason: string; overridden: boolean }[]>`
    SELECT state, reason, overridden FROM effective_capabilities
    WHERE network = ${input.network} AND market_id = ${input.marketId} AND action = ${input.action}
  `;
  return row ?? null;
}

/**
 * Tries to acquire a session-level advisory lock for a worker process on a network.
 * Returns true if the lock was acquired, false if another worker process is already running.
 */
export async function tryAcquireWorkerLock(sql: Sql, processName: string, network: NetworkName): Promise<boolean> {
  const lockKey = `stacks-capital:worker:${processName}:${network}`;
  const [row] = await sql<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS acquired
  `;
  return row?.acquired ?? false;
}

/**
 * Releases the session-level advisory lock for a worker process on a network.
 */
export async function releaseWorkerLock(sql: Sql, processName: string, network: NetworkName): Promise<boolean> {
  const lockKey = `stacks-capital:worker:${processName}:${network}`;
  const [row] = await sql<{ released: boolean }[]>`
    SELECT pg_advisory_unlock(hashtext(${lockKey})) AS released
  `;
  return row?.released ?? false;
}
