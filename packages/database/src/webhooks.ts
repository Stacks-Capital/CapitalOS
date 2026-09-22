import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Sql } from "./lib.ts";

export type WebhookEndpointRecord = {
  id: string;
  appId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  secret?: string; // Only returned on creation
};

export type WebhookDeliveryRecord = {
  id: string;
  appId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  status: "pending" | "delivered" | "failed" | "abandoned";
  nextRetryAt: Date | null;
  lastAttemptAt: Date | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
};

const sha256 = (val: string): string => createHash("sha256").update(val).digest("hex");

/**
 * Register a new webhook endpoint for a partner app.
 * Returns the plaintext secret `whsec_...` ONCE upon creation.
 */
export async function createWebhookEndpoint(
  sql: Sql,
  input: { appId: string; url: string; events: string[] },
): Promise<WebhookEndpointRecord> {
  const id = `whe_${randomBytes(8).toString("hex")}`;
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const secretHash = sha256(secret);

  const [row] = await sql<
    {
      id: string;
      appId: string;
      url: string;
      events: string[];
      active: boolean;
      createdAt: Date;
      updatedAt: Date;
    }[]
  >`
    INSERT INTO webhook_endpoints (id, app_id, url, secret_hash, events, active)
    VALUES (${id}, ${input.appId}, ${input.url}, ${secretHash}, ${sql.array(input.events)}, true)
    RETURNING id, app_id AS "appId", url, events, active, created_at AS "createdAt", updated_at AS "updatedAt"
  `;

  if (!row) throw new Error("Failed to insert webhook endpoint");
  return { ...row, secret };
}

/**
 * List all active webhook endpoints for a partner app.
 */
export async function listWebhookEndpoints(sql: Sql, appId: string): Promise<WebhookEndpointRecord[]> {
  return sql<WebhookEndpointRecord[]>`
    SELECT id, app_id AS "appId", url, events, active, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM webhook_endpoints
    WHERE app_id = ${appId} AND active = true
    ORDER BY created_at DESC
  `;
}

/**
 * Deactivate a webhook endpoint for a partner app.
 */
export async function deleteWebhookEndpoint(sql: Sql, appId: string, endpointId: string): Promise<boolean> {
  const result = await sql`
    UPDATE webhook_endpoints
    SET active = false, disabled_at = now(), updated_at = now()
    WHERE id = ${endpointId} AND app_id = ${appId} AND active = true
  `;
  return result.count > 0;
}

/**
 * Find a webhook endpoint by ID.
 */
export async function findWebhookEndpoint(
  sql: Sql,
  endpointId: string,
): Promise<{ id: string; appId: string; url: string; secretHash: string; events: string[]; active: boolean } | null> {
  const [row] = await sql<
    { id: string; appId: string; url: string; secretHash: string; events: string[]; active: boolean }[]
  >`
    SELECT id, app_id AS "appId", url, secret_hash AS "secretHash", events, active
    FROM webhook_endpoints
    WHERE id = ${endpointId}
  `;
  return row ?? null;
}

/**
 * Signs a webhook payload using HMAC-SHA256.
 * Format: `t=<timestamp>,v1=<signature>`
 */
export function signWebhookPayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): { signature: string; timestamp: number; header: string } {
  const toSign = `${timestamp}.${payload}`;
  const signature = createHmac("sha256", secret).update(toSign).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;
  return { signature, timestamp, header };
}

/**
 * Verifies a webhook signature and enforces timestamp tolerance to prevent replay attacks.
 */
export function verifyWebhookSignature(
  payload: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): { valid: boolean; reason?: string } {
  const parts = header.split(",").map((p) => p.trim());
  let tStr: string | undefined;
  let v1Str: string | undefined;

  for (const part of parts) {
    if (part.startsWith("t=")) {
      tStr = part.slice(2);
    } else if (part.startsWith("v1=")) {
      v1Str = part.slice(3);
    }
  }

  if (!tStr || !v1Str) {
    return { valid: false, reason: "Missing timestamp or signature in header" };
  }

  const timestamp = Number.parseInt(tStr, 10);
  if (Number.isNaN(timestamp)) {
    return { valid: false, reason: "Malformed timestamp in signature header" };
  }

  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { valid: false, reason: "Webhook timestamp expired or outside tolerance window" };
  }

  const expectedToSign = `${timestamp}.${payload}`;
  const expectedSig = createHmac("sha256", secret).update(expectedToSign).digest("hex");

  const sigBuf = Buffer.from(v1Str, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return { valid: true };
}

export type RecordDeliveryResult = {
  deliveryId: string;
  isDuplicate: boolean;
  status: string;
};

/**
 * Idempotently records a webhook delivery.
 * Enforces deduplication via UNIQUE (endpoint_id, event_id).
 */
export async function recordWebhookDelivery(
  sql: Sql,
  input: {
    appId: string;
    endpointId: string;
    eventId: string;
    eventType: string;
    payload: unknown;
  },
): Promise<RecordDeliveryResult> {
  const id = `whd_${randomBytes(12).toString("hex")}`;
  const payloadJson = sql.json(input.payload as never);

  const inserted = await sql<{ id: string; status: string }[]>`
    INSERT INTO webhook_deliveries (id, app_id, endpoint_id, event_id, event_type, payload, status, next_retry_at)
    VALUES (${id}, ${input.appId}, ${input.endpointId}, ${input.eventId}, ${input.eventType}, ${payloadJson}, 'pending', now())
    ON CONFLICT (endpoint_id, event_id) DO NOTHING
    RETURNING id, status
  `;

  if (inserted.length > 0 && inserted[0]) {
    return { deliveryId: inserted[0].id, isDuplicate: false, status: inserted[0].status };
  }

  // Row already exists -> deduplication triggered
  const [existing] = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM webhook_deliveries
    WHERE endpoint_id = ${input.endpointId} AND event_id = ${input.eventId}
  `;

  if (!existing) throw new Error("Could not find or insert webhook delivery");
  return { deliveryId: existing.id, isDuplicate: true, status: existing.status };
}

/**
 * Processes a webhook delivery outcome.
 * On success, sets status to 'delivered'.
 * On failure, increments attempts and schedules next retry with exponential backoff (2^attempts seconds),
 * or marks as 'abandoned' when max_attempts is reached.
 */
export async function processWebhookDeliveryAttempt(
  sql: Sql,
  deliveryId: string,
  outcome: {
    status: "delivered" | "failed";
    responseStatus?: number;
    error?: string;
  },
  now = new Date(),
): Promise<{ status: string; attempts: number; nextRetryAt: Date | null }> {
  if (outcome.status === "delivered") {
    const [row] = await sql<{ status: string; attempts: number; nextRetryAt: Date | null }[]>`
      UPDATE webhook_deliveries
      SET status = 'delivered',
          attempts = attempts + 1,
          last_attempt_at = ${now},
          delivered_at = ${now},
          response_status = ${outcome.responseStatus ?? 200},
          error = null,
          next_retry_at = null
      WHERE id = ${deliveryId}
      RETURNING status, attempts, next_retry_at AS "nextRetryAt"
    `;
    if (!row) throw new Error(`Delivery ${deliveryId} not found`);
    return row;
  }

  // Delivery failed: check attempts count
  const [current] = await sql<{ attempts: number; maxAttempts: number }[]>`
    SELECT attempts, max_attempts AS "maxAttempts" FROM webhook_deliveries WHERE id = ${deliveryId}
  `;
  if (!current) throw new Error(`Delivery ${deliveryId} not found`);

  const nextAttempt = current.attempts + 1;
  const isAbandoned = nextAttempt >= current.maxAttempts;
  const newStatus = isAbandoned ? "abandoned" : "pending";

  // Exponential backoff: 2^attempt seconds (attempt 1: 2s, attempt 2: 4s, attempt 3: 8s, ...)
  const backoffSeconds = isAbandoned ? 0 : Math.min(3600, 2 ** nextAttempt);
  const nextRetryAt = isAbandoned ? null : new Date(now.getTime() + backoffSeconds * 1000);

  const [updated] = await sql<{ status: string; attempts: number; nextRetryAt: Date | null }[]>`
    UPDATE webhook_deliveries
    SET status = ${newStatus},
        attempts = ${nextAttempt},
        last_attempt_at = ${now},
        next_retry_at = ${nextRetryAt},
        response_status = ${outcome.responseStatus ?? null},
        error = ${outcome.error ?? "Delivery attempt failed"}
    WHERE id = ${deliveryId}
    RETURNING status, attempts, next_retry_at AS "nextRetryAt"
  `;

  if (!updated) throw new Error(`Delivery ${deliveryId} update failed`);
  return updated;
}
