-- Prices and reconciliation runs for the ingestion worker (I06, K05 pipeline steps 5 and 6).

CREATE TABLE price_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network network_name NOT NULL,
  -- Oracle feed key as the source names it, for example BTC/USD.
  feed_key text NOT NULL CHECK (feed_key ~ '^[A-Za-z0-9/._-]{1,32}$'),
  -- Price is value / 10^price_scale. A zero or missing price is stored as null with a warning, never as 0.
  price numeric(78, 0) CHECK (price > 0),
  price_scale smallint NOT NULL CHECK (price_scale BETWEEN 0 AND 38),
  -- When the oracle says the price was published, which is what staleness is measured from.
  published_at timestamptz,
  stale boolean NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  block_height bigint CHECK (block_height >= 0),
  block_hash text,
  UNIQUE (network, feed_key, source, observed_at),
  CHECK ((block_height IS NULL) = (block_hash IS NULL)),
  CHECK (price IS NOT NULL OR cardinality(warnings) > 0),
  CHECK (price IS NOT NULL OR stale)
);

CREATE INDEX price_snapshots_by_feed ON price_snapshots (network, feed_key, observed_at DESC);

CREATE TABLE reconciliation_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network network_name NOT NULL,
  market_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('match', 'mismatch', 'unavailable')),
  detail text NOT NULL,
  -- What the projection held and what a direct contract read returned, kept for the audit trail.
  projected jsonb,
  observed jsonb,
  source text NOT NULL,
  run_at timestamptz NOT NULL,
  FOREIGN KEY (network, market_id) REFERENCES markets (network, id),
  CHECK (status <> 'mismatch' OR (projected IS NOT NULL AND observed IS NOT NULL))
);

CREATE INDEX reconciliation_runs_by_market ON reconciliation_runs (network, market_id, run_at DESC);

CREATE TRIGGER reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION reject_row_change();
