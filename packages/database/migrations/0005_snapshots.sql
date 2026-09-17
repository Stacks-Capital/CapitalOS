-- Financial projections: market, position and wallet balance snapshots.
-- Unknown or stale values are stored as null with a warning, never as zero (page 01).

CREATE DOMAIN position_kind AS text CHECK (VALUE IN (
  'wallet', 'supplied', 'debt', 'collateral', 'pending_deposit', 'pending_withdrawal', 'staked'
));

CREATE TABLE market_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network network_name NOT NULL,
  market_id text NOT NULL,
  -- Rates are fixed decimals: value / 10^rate_scale.
  supply_rate numeric(78, 0),
  borrow_rate numeric(78, 0),
  rate_scale smallint CHECK (rate_scale BETWEEN 0 AND 38),
  available_liquidity token_quantity CHECK (available_liquidity >= 0),
  capacity token_quantity CHECK (capacity >= 0),
  paused boolean,
  stale boolean NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  block_height bigint CHECK (block_height >= 0),
  block_hash text,
  adapter_version text NOT NULL,
  calculation_version text NOT NULL,
  FOREIGN KEY (network, market_id) REFERENCES markets (network, id),
  UNIQUE (network, market_id, source, observed_at),
  CHECK ((supply_rate IS NULL AND borrow_rate IS NULL) OR rate_scale IS NOT NULL),
  CHECK ((block_height IS NULL) = (block_hash IS NULL)),
  CHECK (available_liquidity IS NOT NULL OR cardinality(warnings) > 0)
);

CREATE TABLE position_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner text NOT NULL,
  network network_name NOT NULL,
  deployment_id text NOT NULL,
  market_id text NOT NULL,
  kind position_kind NOT NULL,
  protocol_key text NOT NULL,
  asset_id text NOT NULL REFERENCES assets (id),
  quantity token_quantity CHECK (quantity >= 0),
  stale boolean NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  block_height bigint CHECK (block_height >= 0),
  block_hash text,
  adapter_version text NOT NULL,
  calculation_version text NOT NULL,
  FOREIGN KEY (deployment_id, network) REFERENCES deployments (id, network),
  FOREIGN KEY (network, market_id) REFERENCES markets (network, id),
  -- PositionId in core: owner + deployment + market + position kind + protocol position key.
  UNIQUE (owner, deployment_id, market_id, kind, protocol_key, asset_id, source, observed_at),
  CHECK ((block_height IS NULL) = (block_hash IS NULL)),
  CHECK (quantity IS NOT NULL OR cardinality(warnings) > 0)
);

CREATE TABLE wallet_balance_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network network_name NOT NULL,
  address text NOT NULL,
  asset_id text NOT NULL REFERENCES assets (id),
  quantity token_quantity CHECK (quantity >= 0),
  stale boolean NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  block_height bigint CHECK (block_height >= 0),
  block_hash text,
  UNIQUE (network, address, asset_id, source, observed_at),
  CHECK ((block_height IS NULL) = (block_hash IS NULL)),
  CHECK (quantity IS NOT NULL OR cardinality(warnings) > 0)
);
