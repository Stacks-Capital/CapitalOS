import {
  type AlertInput,
  type MetricsSnapshot,
  type NetworkName,
  openAlerts,
  raiseAlert,
  resolveAlert,
  type Sql,
} from "@stacks-capital/database";

export type AlertThresholds = {
  lagBlocksWarning: number;
  lagBlocksCritical: number;
  /** A checkpoint that has not moved in this long means ingestion has stopped, whatever the lag says. */
  checkpointStaleSeconds: number;
  ingestionFailuresCritical: number;
  /** Fewer attempts than this is too little to judge a failure rate on. */
  quoteMinAttempts: number;
  quoteFailureRateWarning: number;
  quoteFailureRateCritical: number;
};

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  lagBlocksWarning: 30,
  lagBlocksCritical: 120,
  checkpointStaleSeconds: 10 * 60,
  ingestionFailuresCritical: 3,
  quoteMinAttempts: 5,
  quoteFailureRateWarning: 0.2,
  quoteFailureRateCritical: 0.5,
};

// States where nothing will fix itself and a person has to act.
const NEEDS_A_PERSON = new Set(["BROADCAST_UNKNOWN", "REORGED", "MANUAL_REVIEW"]);

/** What should be open right now, given the metrics. Each alert has a key that names the problem, not the moment. */
export function evaluateAlerts(
  snapshot: MetricsSnapshot,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): AlertInput[] {
  const network: NetworkName = snapshot.network;
  const alerts: AlertInput[] = [];
  const ingestion = snapshot.ingestion;

  const lag = ingestion.blocksBehind;
  if (lag !== null && lag >= thresholds.lagBlocksWarning) {
    alerts.push({
      dedupeKey: `ingestion_lag:${network}`,
      kind: "ingestion_lag",
      severity: lag >= thresholds.lagBlocksCritical ? "critical" : "warning",
      network,
      subject: "stacks",
      message: `Ingestion is ${lag} blocks behind the chain tip.`,
    });
  }

  const checkpointAge =
    ingestion.checkpointAt === null ? null : (snapshot.at.getTime() - ingestion.checkpointAt.getTime()) / 1000;
  const stopped = checkpointAge !== null && checkpointAge >= thresholds.checkpointStaleSeconds;
  if (stopped || ingestion.failuresInWindow >= thresholds.ingestionFailuresCritical) {
    alerts.push({
      dedupeKey: `ingestion_failing:${network}`,
      kind: "ingestion_failing",
      severity: "critical",
      network,
      subject: "stacks",
      message: stopped
        ? `The checkpoint has not moved for ${Math.round((checkpointAge ?? 0) / 60)} minutes.`
        : `Ingestion failed ${ingestion.failuresInWindow} times in the window.`,
    });
  }

  for (const quotes of snapshot.quotes) {
    if (quotes.attempts < thresholds.quoteMinAttempts) continue;
    const rate = quotes.failures / quotes.attempts;
    if (rate < thresholds.quoteFailureRateWarning) continue;
    const codes = Object.entries(quotes.codes)
      .sort(([, left], [, right]) => right - left)
      .map(([code, count]) => `${code} ${count}`)
      .join(", ");
    alerts.push({
      dedupeKey: `quote_failures:${network}:${quotes.subject}`,
      kind: "quote_failures",
      severity: rate >= thresholds.quoteFailureRateCritical ? "critical" : "warning",
      network,
      subject: quotes.subject,
      message: `${quotes.failures} of ${quotes.attempts} quotes failed for ${quotes.subject} (${codes}).`,
    });
  }

  for (const workflow of snapshot.stuck) {
    alerts.push({
      dedupeKey: `workflow_stuck:${network}:${workflow.id}`,
      kind: "workflow_stuck",
      severity: NEEDS_A_PERSON.has(workflow.state) ? "critical" : "warning",
      network,
      subject: workflow.id,
      message: `${workflow.id} has been ${workflow.state} for ${Math.round(workflow.ageSeconds / 60)} minutes. Next: ${workflow.nextAction}.`,
    });
  }

  return alerts;
}

export type Notification = { event: "opened" | "resolved"; dedupeKey: string; severity?: string; message?: string };

/**
 * Makes the open alerts match what should be open. A problem seen again updates its open alert instead
 * of opening another, and only a change (opened or resolved) produces a notification.
 */
export async function reconcileAlerts(
  sql: Sql,
  network: NetworkName,
  desired: AlertInput[],
  at: Date,
): Promise<{ notifications: Notification[]; open: number }> {
  const notifications: Notification[] = [];
  for (const alert of desired) {
    if (await raiseAlert(sql, alert, at)) {
      notifications.push({
        event: "opened",
        dedupeKey: alert.dedupeKey,
        severity: alert.severity,
        message: alert.message,
      });
    }
  }
  const wanted = new Set(desired.map((alert) => alert.dedupeKey));
  for (const open of await openAlerts(sql, network)) {
    if (wanted.has(open.dedupeKey)) continue;
    if (await resolveAlert(sql, open.dedupeKey, at))
      notifications.push({ event: "resolved", dedupeKey: open.dedupeKey });
  }
  return { notifications, open: wanted.size };
}
