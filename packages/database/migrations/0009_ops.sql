-- Operations (I17): what happened, what is wrong now, and what operators have switched off.

-- Raw operational facts, written by the API and the worker. Metrics are computed from these.
CREATE TABLE ops_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('quote_succeeded', 'quote_failed', 'ingestion_tick', 'ingestion_failed')),
  network network_name NOT NULL,
  -- The market for a quote, the chain for ingestion.
  subject text NOT NULL,
  -- The error code for a failure, null otherwise.
  code text,
  -- Blocks behind the tip for an ingestion tick, null otherwise.
  value bigint,
  at timestamptz NOT NULL
);

CREATE INDEX ops_events_by_kind ON ops_events (network, kind, at DESC);

-- One row per problem, however many times it is seen. Reopening after resolution is a new row.
CREATE TABLE alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ingestion_lag', 'ingestion_failing', 'quote_failures', 'workflow_stuck')),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  network network_name NOT NULL,
  subject text NOT NULL,
  message text NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  resolved_at timestamptz,
  CHECK (last_seen >= first_seen),
  CHECK (resolved_at IS NULL OR resolved_at >= first_seen)
);

-- The dedupe guarantee: at most one open alert per key.
CREATE UNIQUE INDEX alerts_one_open_per_key ON alerts (dedupe_key) WHERE resolved_at IS NULL;

-- Operator switches. An override can only make a capability stricter than the registry says.
CREATE TABLE capability_overrides (
  network network_name NOT NULL,
  market_id text NOT NULL,
  action action_name NOT NULL,
  state capability_state NOT NULL CHECK (state IN ('paused', 'disabled')),
  reason text NOT NULL CHECK (length(reason) > 0),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL,
  PRIMARY KEY (network, market_id, action),
  FOREIGN KEY (network, market_id, action) REFERENCES capabilities (network, market_id, action)
);

-- The state callers see. Strictness runs enabled, read_only, paused, disabled, and the stricter of the
-- registry and the override wins, so an operator can switch something off but never on.
CREATE VIEW effective_capabilities AS
SELECT c.network,
       c.market_id,
       c.action,
       CASE
         WHEN o.state IS NOT NULL
              AND (CASE o.state WHEN 'disabled' THEN 3 WHEN 'paused' THEN 2 ELSE 0 END)
                > (CASE c.state WHEN 'disabled' THEN 3 WHEN 'paused' THEN 2 WHEN 'read_only' THEN 1 ELSE 0 END)
         THEN o.state
         ELSE c.state
       END AS state,
       CASE
         WHEN o.state IS NOT NULL
              AND (CASE o.state WHEN 'disabled' THEN 3 WHEN 'paused' THEN 2 ELSE 0 END)
                > (CASE c.state WHEN 'disabled' THEN 3 WHEN 'paused' THEN 2 WHEN 'read_only' THEN 1 ELSE 0 END)
         THEN 'Switched off by an operator: ' || o.reason
         ELSE c.reason
       END AS reason,
       c.contract_id,
       c.deployment_id,
       c.adapter_version,
       c.registry_version,
       o.state IS NOT NULL AS overridden
FROM capabilities c
LEFT JOIN capability_overrides o
  ON o.network = c.network AND o.market_id = c.market_id AND o.action = c.action;
