-- MCH-01 bounded reciprocal introductions.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS introductions;
CREATE TABLE introductions.batches (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  algorithm_version text NOT NULL CHECK (algorithm_version='mch-01-deterministic-v1'),
  config_version text NOT NULL CHECK (config_version='mch-01-config-v1'),
  batch_limit integer NOT NULL CHECK (batch_limit BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL, refresh_after timestamptz NOT NULL,
  UNIQUE(id, account_id)
);
CREATE INDEX introductions_batches_account_mode_idx ON introductions.batches(account_id,mode,created_at DESC);
CREATE TABLE introductions.candidates (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES introductions.batches(id) ON DELETE CASCADE,
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  subject_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  pair_key text NOT NULL CHECK (pair_key <> ''),
  reasons text[] NOT NULL CHECK (cardinality(reasons) BETWEEN 1 AND 8 AND reasons <@ ARRAY['PREFERENCES_ALIGN','SHARED_INTEREST','COMMUNICATION_FIT','PACE_ALIGNMENT','AVAILABILITY_ALIGNMENT','LANGUAGE_ALIGNMENT','GEOGRAPHY_ALIGNMENT','VALUES_ALIGNMENT']),
  visible_facts text[] NOT NULL CHECK (cardinality(visible_facts) BETWEEN 0 AND 16),
  score integer NOT NULL CHECK (score >= 0),
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL, UNIQUE(batch_id,actor_account_id,subject_account_id),
  CHECK (actor_account_id <> subject_account_id)
);
CREATE INDEX introductions_candidates_actor_idx ON introductions.candidates(actor_account_id,created_at DESC,id);
CREATE INDEX introductions_candidates_pair_idx ON introductions.candidates(pair_key,mode,created_at DESC);
CREATE TABLE introductions.decisions (
  id uuid PRIMARY KEY, introduction_id uuid NOT NULL REFERENCES introductions.candidates(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES introductions.batches(id) ON DELETE CASCADE,
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('interested','pass')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  actor_proof text NOT NULL CHECK (actor_proof ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL, UNIQUE(introduction_id,actor_account_id)
);
CREATE TABLE introductions.outcomes (
  id uuid PRIMARY KEY, pair_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  introduction_id uuid NOT NULL REFERENCES introductions.candidates(id) ON DELETE CASCADE,
  subject_introduction_id uuid NOT NULL REFERENCES introductions.candidates(id) ON DELETE CASCADE,
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  subject_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  actor_proof text NOT NULL CHECK (actor_proof ~ '^[0-9a-f]{64}$'),
  subject_proof text NOT NULL CHECK (subject_proof ~ '^[0-9a-f]{64}$'),
  materialization_key text NOT NULL, materialized_reference text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(pair_key,mode), UNIQUE(materialization_key)
);
CREATE TABLE introductions.cooldowns (
  pair_key text NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  subject_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  until_at timestamptz NOT NULL, source text NOT NULL CHECK(source='pass'), created_at timestamptz NOT NULL,
  PRIMARY KEY(pair_key,mode)
);
CREATE TABLE introductions.idempotency_keys (
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,key_digest)
);
-- CON-owned additive bridge. CON writes this table together with its
-- connection and transition rows; MCH only supplies opaque mutual proofs.
CREATE TABLE connection.mutual_materializations (
  id uuid PRIMARY KEY,
  introduction_id uuid NOT NULL,
  pair_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  subject_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  actor_proof text NOT NULL CHECK (actor_proof ~ '^[0-9a-f]{64}$'),
  subject_proof text NOT NULL CHECK (subject_proof ~ '^[0-9a-f]{64}$'),
  materialization_key text NOT NULL,
  connection_id uuid NOT NULL REFERENCES connection.connections(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  UNIQUE(pair_key,mode), UNIQUE(introduction_id), UNIQUE(materialization_key)
);
CREATE INDEX connection_mutual_materializations_connection_idx ON connection.mutual_materializations(connection_id);
CREATE OR REPLACE FUNCTION connection.mutual_connection_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()<=1 AND EXISTS(
    SELECT 1 FROM connection.mutual_materializations m
    WHERE m.connection_id=OLD.id
      AND EXISTS(SELECT 1 FROM iam.accounts a WHERE a.id=m.actor_account_id)
      AND EXISTS(SELECT 1 FROM iam.accounts a WHERE a.id=m.subject_account_id)
  ) THEN
    RAISE EXCEPTION 'materialized connection is immutable; use disconnect transition';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER mutual_connection_delete_guard BEFORE DELETE ON connection.connections
FOR EACH ROW EXECUTE FUNCTION connection.mutual_connection_delete_guard();
CREATE OR REPLACE FUNCTION connection.mutual_materialization_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Account/connection erasure is the only deletion path. Direct member
  -- mutation remains forbidden while parent cleanup can cascade safely.
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' AND (
    NOT EXISTS(SELECT 1 FROM iam.accounts WHERE id=OLD.actor_account_id) OR
    NOT EXISTS(SELECT 1 FROM iam.accounts WHERE id=OLD.subject_account_id) OR
    NOT EXISTS(SELECT 1 FROM connection.connections WHERE id=OLD.connection_id)
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'connection mutual materialization is immutable';
END $$;
CREATE TRIGGER mutual_materializations_frozen BEFORE UPDATE OR DELETE ON connection.mutual_materializations FOR EACH ROW EXECUTE FUNCTION connection.mutual_materialization_immutable();
CREATE OR REPLACE FUNCTION introductions.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM iam.accounts WHERE id=OLD.account_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'introductions append-only row';
END $$;
CREATE OR REPLACE FUNCTION introductions.reject_candidate_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM iam.accounts WHERE id=OLD.actor_account_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'introductions frozen row';
END $$;
CREATE OR REPLACE FUNCTION introductions.reject_cooldown_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM iam.accounts WHERE id=OLD.actor_account_id) OR NOT EXISTS(SELECT 1 FROM iam.accounts WHERE id=OLD.subject_account_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'introductions cooldown is immutable';
END $$;
CREATE OR REPLACE FUNCTION introductions.reject_idempotency_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM iam.accounts WHERE id=OLD.account_id) THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.account_id<>OLD.account_id OR NEW.key_digest<>OLD.key_digest OR NEW.payload_digest<>OLD.payload_digest OR NEW.created_at<>OLD.created_at
      OR OLD.result->>'outcome' IS NOT NULL OR NEW.result->>'outcome' IS DISTINCT FROM 'mutual'
      OR NEW.result->>'introduction_id' IS DISTINCT FROM OLD.result->>'introduction_id' THEN
      RAISE EXCEPTION 'idempotency record is immutable';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'idempotency record is immutable';
END $$;
CREATE TRIGGER introductions_batches_frozen BEFORE UPDATE OR DELETE ON introductions.batches FOR EACH ROW EXECUTE FUNCTION introductions.reject_mutation();
CREATE TRIGGER introductions_candidates_frozen BEFORE UPDATE OR DELETE ON introductions.candidates FOR EACH ROW EXECUTE FUNCTION introductions.reject_candidate_mutation();
CREATE TRIGGER introductions_decisions_frozen BEFORE UPDATE OR DELETE ON introductions.decisions FOR EACH ROW EXECUTE FUNCTION introductions.reject_candidate_mutation();
CREATE TRIGGER introductions_outcomes_frozen BEFORE UPDATE OR DELETE ON introductions.outcomes FOR EACH ROW EXECUTE FUNCTION introductions.reject_candidate_mutation();
CREATE TRIGGER introductions_cooldowns_frozen BEFORE UPDATE OR DELETE ON introductions.cooldowns FOR EACH ROW EXECUTE FUNCTION introductions.reject_cooldown_mutation();
CREATE TRIGGER introductions_idempotency_frozen BEFORE UPDATE OR DELETE ON introductions.idempotency_keys FOR EACH ROW EXECUTE FUNCTION introductions.reject_idempotency_mutation();
-- +END UP
-- +BEGIN DOWN
DROP TRIGGER IF EXISTS introductions_idempotency_frozen ON introductions.idempotency_keys;
DROP TRIGGER IF EXISTS mutual_materializations_frozen ON connection.mutual_materializations;
DROP TRIGGER IF EXISTS mutual_connection_delete_guard ON connection.connections;
DROP TABLE IF EXISTS connection.mutual_materializations;
DROP FUNCTION IF EXISTS connection.mutual_connection_delete_guard();
DROP FUNCTION IF EXISTS connection.mutual_materialization_immutable();
DROP FUNCTION IF EXISTS introductions.reject_idempotency_mutation();
DROP SCHEMA IF EXISTS introductions CASCADE;
-- +END DOWN
