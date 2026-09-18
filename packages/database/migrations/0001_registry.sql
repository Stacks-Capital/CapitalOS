-- Registry: protocols, deployments, assets, markets and per action capabilities (page 01 data model).

CREATE DOMAIN network_name AS text CHECK (VALUE IN ('mainnet', 'testnet'));
CREATE DOMAIN chain_name AS text CHECK (VALUE IN ('bitcoin', 'stacks'));
CREATE DOMAIN action_name AS text
  CHECK (VALUE IN ('deposit_sbtc', 'withdraw_sbtc', 'supply', 'withdraw_supply', 'borrow', 'repay', 'swap', 'stake'));
CREATE DOMAIN capability_state AS text CHECK (VALUE IN ('enabled', 'read_only', 'paused', 'disabled'));

-- Token quantities are base-10 integers in base units. uint128 needs 39 digits.
CREATE DOMAIN token_quantity AS numeric(78, 0);

CREATE TABLE protocols (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]+$')
);

CREATE TABLE deployments (
  id text PRIMARY KEY,
  protocol_id text NOT NULL REFERENCES protocols (id),
  network network_name NOT NULL,
  contract_id text NOT NULL CHECK (contract_id ~ '^S[0-9A-Z]+\.[a-zA-Z][a-zA-Z0-9_-]*$'),
  revision text NOT NULL,
  label text NOT NULL,
  role text NOT NULL,
  UNIQUE (protocol_id, network, contract_id, revision),
  UNIQUE (id, network),
  -- Mirrors formatDeploymentId in @stacks-capital/core.
  CHECK (id = protocol_id || ':' || network || ':' || contract_id || '@' || revision)
);

CREATE TABLE assets (
  id text PRIMARY KEY,
  chain chain_name NOT NULL,
  network network_name NOT NULL,
  kind text NOT NULL CHECK (kind IN ('native', 'contract')),
  symbol text CHECK (symbol IN ('btc', 'stx')),
  principal text,
  asset_name text,
  decimals smallint CHECK (decimals BETWEEN 0 AND 38),
  -- Mirrors formatAssetId in @stacks-capital/core, so a bare ticker can never be stored as an asset id.
  CHECK (
    (kind = 'native' AND symbol IS NOT NULL AND principal IS NULL AND asset_name IS NULL
      AND id = chain || ':' || network || ':native:' || symbol)
    OR (kind = 'contract' AND symbol IS NULL AND principal IS NOT NULL AND asset_name IS NOT NULL
      AND id = chain || ':' || network || ':contract:' || principal || ':' || asset_name)
  )
);

CREATE TABLE markets (
  network network_name NOT NULL,
  id text NOT NULL,
  protocol_id text NOT NULL REFERENCES protocols (id),
  supplied_asset_id text REFERENCES assets (id),
  receipt_asset_id text REFERENCES assets (id),
  PRIMARY KEY (network, id)
);

CREATE TABLE capabilities (
  network network_name NOT NULL,
  market_id text NOT NULL,
  action action_name NOT NULL,
  state capability_state NOT NULL,
  reason text NOT NULL,
  contract_id text NOT NULL,
  deployment_id text,
  adapter_version text NOT NULL,
  registry_version text NOT NULL,
  PRIMARY KEY (network, market_id, action),
  FOREIGN KEY (network, market_id) REFERENCES markets (network, id),
  FOREIGN KEY (deployment_id, network) REFERENCES deployments (id, network),
  -- Only a verified deployment on the same network can back an action that is not disabled.
  CHECK (state = 'disabled' OR deployment_id IS NOT NULL)
);
