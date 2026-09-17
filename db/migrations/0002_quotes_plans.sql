-- Quotes and plans. Amounts cross JSON as {"asset": "<asset id>", "quantity": "<base-10 integer string>"}.

CREATE FUNCTION valid_amounts(amounts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(amounts) = 'array'
    AND NOT jsonb_path_exists(amounts, '$[*] ? (@.type() != "object")')
    AND NOT jsonb_path_exists(amounts, '$[*] ? (!(exists(@.asset)) || !(exists(@.quantity)))')
    AND NOT jsonb_path_exists(amounts, '$[*].asset ? (@.type() != "string")')
    AND NOT jsonb_path_exists(amounts, '$[*].quantity ? (@.type() != "string")')
    AND NOT jsonb_path_exists(amounts, '$[*].quantity ? (!(@ like_regex "^-?[0-9]+$"))')
$$;

CREATE TABLE quotes (
  id text PRIMARY KEY,
  network network_name NOT NULL,
  market_id text NOT NULL,
  action action_name NOT NULL,
  input jsonb NOT NULL CHECK (valid_amounts(input)),
  expected_output jsonb NOT NULL CHECK (valid_amounts(expected_output)),
  minimum_output jsonb CHECK (minimum_output IS NULL OR valid_amounts(jsonb_build_array(minimum_output))),
  fees jsonb NOT NULL DEFAULT '[]' CHECK (
    jsonb_typeof(fees) = 'array'
    AND valid_amounts(jsonb_path_query_array(fees, '$[*].amount'))
    AND valid_amounts(jsonb_path_query_array(fees, '$[*].max'))
  ),
  snapshots text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  executable boolean NOT NULL,
  registry_version text NOT NULL,
  adapter_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, network),
  -- A quote can only exist for an action the registry lists for that market.
  FOREIGN KEY (network, market_id, action) REFERENCES capabilities (network, market_id, action)
);

CREATE TABLE plans (
  id text PRIMARY KEY,
  quote_id text NOT NULL UNIQUE,
  network network_name NOT NULL,
  registry_version text NOT NULL,
  adapter_version text NOT NULL,
  steps jsonb NOT NULL CHECK (
    jsonb_typeof(steps) = 'array'
    AND jsonb_array_length(steps) > 0
    -- Token quantities anywhere in a plan are strings, never JSON numbers.
    AND NOT jsonb_path_exists(steps, 'lax $.**.quantity ? (@.type() != "string")')
  ),
  review_summary text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The plan must be on the same network as the quote it binds.
  FOREIGN KEY (quote_id, network) REFERENCES quotes (id, network)
);
