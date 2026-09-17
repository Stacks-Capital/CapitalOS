-- Workflows, steps, transaction attempts and state transitions. States and next actions follow
-- packages/core/src/workflow.ts.

CREATE DOMAIN workflow_state AS text CHECK (VALUE IN (
  'DRAFT', 'QUOTED', 'AWAITING_SIGNATURE', 'BROADCAST_UNKNOWN', 'SUBMITTED', 'CONFIRMING', 'STEP_CONFIRMED',
  'RECONCILING', 'ACTION_REQUIRED', 'REORGED', 'MANUAL_REVIEW', 'COMPLETED', 'EXPIRED', 'USER_REJECTED', 'FAILED'
));

CREATE DOMAIN workflow_next_action AS text CHECK (VALUE IN (
  'SIGN', 'REQUOTE', 'WAIT', 'RETRY_READ', 'RECLAIM', 'CONTACT_SUPPORT', 'COMPLETE', 'START_NEW'
));

CREATE FUNCTION reject_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TABLE workflows (
  id text PRIMARY KEY,
  network network_name NOT NULL,
  -- Page 01: an idempotency key prevents duplicate workflow creation.
  idempotency_key text NOT NULL UNIQUE,
  quote_id text,
  plan_id text REFERENCES plans (id),
  state workflow_state NOT NULL,
  next_action workflow_next_action NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (quote_id, network) REFERENCES quotes (id, network)
);

CREATE TABLE workflow_steps (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows (id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL CHECK (kind IN ('bitcoin_deposit', 'stacks_contract_call')),
  depends_on text[] NOT NULL DEFAULT '{}',
  UNIQUE (workflow_id, ordinal),
  UNIQUE (workflow_id, id)
);

CREATE TABLE transaction_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id text NOT NULL,
  step_id text NOT NULL,
  chain chain_name NOT NULL,
  network network_name NOT NULL,
  -- Matches walletOutcome in core: only a non-empty txid counts as broadcast.
  outcome text NOT NULL CHECK (outcome IN ('BROADCAST', 'SIGNED', 'UNKNOWN')),
  txid text CHECK (txid <> ''),
  nonce bigint CHECK (nonce >= 0),
  evidence text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, step_id) REFERENCES workflow_steps (workflow_id, id),
  CHECK ((outcome = 'BROADCAST') = (txid IS NOT NULL))
);

-- The same transaction is recorded once, so a retry can never create a second attempt for it.
CREATE UNIQUE INDEX transaction_attempts_one_row_per_txid
  ON transaction_attempts (chain, network, txid) WHERE txid IS NOT NULL;

CREATE TRIGGER transaction_attempts_append_only BEFORE UPDATE OR DELETE ON transaction_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_row_change();

CREATE TABLE state_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows (id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state workflow_state NOT NULL,
  to_state workflow_state NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  evidence text NOT NULL,
  at timestamptz NOT NULL,
  UNIQUE (workflow_id, sequence),
  CHECK (from_state <> to_state)
);

CREATE TRIGGER state_transitions_append_only BEFORE UPDATE OR DELETE ON state_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_row_change();
