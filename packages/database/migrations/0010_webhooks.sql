-- Webhooks for partner tenants: endpoints, subscriptions, deliveries, and deduplication (I28).

CREATE TABLE webhook_endpoints (
  id text PRIMARY KEY CHECK (id ~ '^whe_[a-f0-9]{16}$'),
  app_id text NOT NULL REFERENCES partner_apps (id),
  url text NOT NULL CHECK (url ~ '^https?://'),
  -- Only a SHA-256 hash of the secret is stored.
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  events text[] NOT NULL CHECK (cardinality(events) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE INDEX webhook_endpoints_by_app ON webhook_endpoints (app_id);

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY CHECK (id ~ '^whd_[a-f0-9]{24}$'),
  app_id text NOT NULL REFERENCES partner_apps (id),
  endpoint_id text NOT NULL REFERENCES webhook_endpoints (id),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  response_status integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (status, next_retry_at)
  WHERE status = 'pending';
