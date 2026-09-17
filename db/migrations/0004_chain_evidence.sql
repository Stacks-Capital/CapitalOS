-- Chain evidence: blocks, immutable raw events, checkpoints and canonical activities (K05 reorg design).

CREATE TABLE chain_blocks (
  chain chain_name NOT NULL,
  network network_name NOT NULL,
  hash text NOT NULL,
  height bigint NOT NULL CHECK (height >= 0),
  parent_hash text NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (chain, network, hash)
);

-- A reorg marks the old block noncanonical before its replacement at the same height is inserted.
CREATE UNIQUE INDEX chain_blocks_one_canonical_per_height ON chain_blocks (chain, network, height) WHERE canonical;

CREATE FUNCTION evidence_only_canonical_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'canonical') IS DISTINCT FROM (to_jsonb(OLD) - 'canonical') THEN
    RAISE EXCEPTION '% rows are immutable; only canonical may change', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER chain_blocks_immutable BEFORE UPDATE OR DELETE ON chain_blocks
  FOR EACH ROW EXECUTE FUNCTION evidence_only_canonical_changes();

CREATE TABLE raw_events (
  id text PRIMARY KEY,
  chain chain_name NOT NULL,
  network network_name NOT NULL,
  block_hash text NOT NULL,
  payload text NOT NULL,
  source text NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL,
  FOREIGN KEY (chain, network, block_hash) REFERENCES chain_blocks (chain, network, hash)
);

CREATE INDEX raw_events_by_block ON raw_events (chain, network, block_hash);

CREATE TRIGGER raw_events_immutable BEFORE UPDATE OR DELETE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION evidence_only_canonical_changes();

CREATE TABLE ingestion_checkpoints (
  chain chain_name NOT NULL,
  network network_name NOT NULL,
  height bigint NOT NULL CHECK (height >= 0),
  hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, network),
  FOREIGN KEY (chain, network, hash) REFERENCES chain_blocks (chain, network, hash)
);

CREATE TABLE canonical_activities (
  id text PRIMARY KEY,
  raw_event_id text NOT NULL REFERENCES raw_events (id),
  kind text NOT NULL,
  chain chain_name NOT NULL,
  network network_name NOT NULL,
  block_hash text NOT NULL,
  workflow_id text REFERENCES workflows (id),
  canonical boolean NOT NULL DEFAULT true,
  adapter_version text NOT NULL,
  calculation_version text NOT NULL,
  UNIQUE (raw_event_id, kind),
  FOREIGN KEY (chain, network, block_hash) REFERENCES chain_blocks (chain, network, hash)
);
