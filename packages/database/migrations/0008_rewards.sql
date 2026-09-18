-- Reward projections (I11). Rates and accruals carry the time their source reported, normalised to UTC.

CREATE TABLE reward_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network network_name NOT NULL,
  market_id text NOT NULL,
  -- Null for a market wide rate, set for one address's accrual.
  owner text,
  kind text NOT NULL CHECK (kind IN ('rate', 'accrual')),
  -- rate / 10^rate_scale, for example 130 at scale 4 is 1.30%.
  rate numeric(78, 0),
  rate_scale smallint CHECK (rate_scale BETWEEN 0 AND 38),
  accrued token_quantity CHECK (accrued >= 0),
  accrued_asset_id text REFERENCES assets (id),
  -- When the source says the value was last updated, whatever unit it reported.
  updated_at timestamptz,
  stale boolean NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  block_height bigint CHECK (block_height >= 0),
  block_hash text,
  adapter_version text NOT NULL,
  calculation_version text NOT NULL,
  FOREIGN KEY (network, market_id) REFERENCES markets (network, id),
  UNIQUE (network, market_id, kind, owner, source, observed_at),
  CHECK ((block_height IS NULL) = (block_hash IS NULL)),
  CHECK (kind <> 'rate' OR (rate IS NULL) = (rate_scale IS NULL)),
  CHECK (kind <> 'accrual' OR owner IS NOT NULL),
  CHECK ((accrued IS NULL) = (accrued_asset_id IS NULL)),
  -- Unknown is null with a warning, never zero (page 01).
  CHECK (rate IS NOT NULL OR accrued IS NOT NULL OR cardinality(warnings) > 0)
);

CREATE INDEX reward_snapshots_by_market ON reward_snapshots (network, market_id, observed_at DESC);
