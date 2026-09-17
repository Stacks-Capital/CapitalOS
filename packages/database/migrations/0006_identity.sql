-- Identity: partners, their apps, allowed origins, API keys, wallet sign in nonces and sessions (page 03, page 06).

CREATE DOMAIN api_scope AS text
  CHECK (VALUE IN ('markets:read', 'positions:read', 'quotes:write', 'workflows:write', 'webhooks:manage'));

CREATE TABLE partners (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_apps (
  id text PRIMARY KEY,
  partner_id text NOT NULL REFERENCES partners (id),
  name text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  -- Publishable and safe in browser code. It identifies the app but grants nothing on its own.
  client_id text NOT NULL UNIQUE CHECK (client_id ~ '^pk_[a-z0-9_]+$'),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE allowed_origins (
  app_id text NOT NULL REFERENCES partner_apps (id),
  -- Scheme, host and optional port, exactly as browsers send the Origin header.
  origin text NOT NULL CHECK (origin ~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$'),
  PRIMARY KEY (app_id, origin)
);

CREATE TABLE api_keys (
  id text PRIMARY KEY CHECK (id ~ '^key_[a-f0-9]{16}$'),
  app_id text NOT NULL REFERENCES partner_apps (id),
  -- Only a SHA-256 hash of the secret is stored. The full key is shown once, when it is created.
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes api_scope[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE auth_nonces (
  id text PRIMARY KEY CHECK (id ~ '^non_[a-f0-9]{32}$'),
  app_id text NOT NULL,
  origin text NOT NULL,
  address text NOT NULL,
  network network_name NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  -- A nonce is bound to an origin the app allows, so a signature cannot be replayed on another site.
  FOREIGN KEY (app_id, origin) REFERENCES allowed_origins (app_id, origin),
  CHECK (expires_at > created_at)
);

CREATE TABLE user_sessions (
  id text PRIMARY KEY CHECK (id ~ '^ses_[a-f0-9]{16}$'),
  app_id text NOT NULL REFERENCES partner_apps (id),
  address text NOT NULL,
  network network_name NOT NULL,
  -- One session per nonce: a signed challenge can be exchanged only once.
  nonce_id text NOT NULL UNIQUE REFERENCES auth_nonces (id),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

-- Workflows belong to one app and, when created through a wallet session, one address.
-- Rows without an app are readable by no tenant.
ALTER TABLE workflows ADD COLUMN app_id text REFERENCES partner_apps (id);
ALTER TABLE workflows ADD COLUMN owner_address text;
CREATE INDEX workflows_by_app ON workflows (app_id);
