-- TRL-01 provider-neutral, revision-bound derived translations.
-- Tasks and cache rows contain only opaque source identity and encrypted results;
-- providers and queues never become an authorization or durability source.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS translation;

CREATE TABLE translation.tasks (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('public_letter','private_letter')),
  letter_id uuid NOT NULL REFERENCES letters.letters(id) ON DELETE CASCADE,
  source_revision_id uuid NOT NULL REFERENCES letters.letter_revisions(id) ON DELETE CASCADE,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source_locale text NOT NULL CHECK (length(source_locale) BETWEEN 2 AND 64),
  target_locale text NOT NULL CHECK (length(target_locale) BETWEEN 2 AND 64),
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider_version text NOT NULL CHECK (length(provider_version) BETWEEN 1 AND 128),
  consent_id uuid CHECK (consent_id IS NULL OR consent_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  consent_provider_version text CHECK (consent_provider_version IS NULL OR length(consent_provider_version) BETWEEN 1 AND 128),
  consent_processing_region text CHECK (consent_processing_region IS NULL OR length(consent_processing_region) BETWEEN 1 AND 64),
  consent_retention_policy text CHECK (consent_retention_policy IS NULL OR consent_retention_policy IN ('zero','ephemeral','bounded')),
  consent_retention_seconds integer CHECK (consent_retention_seconds IS NULL OR consent_retention_seconds BETWEEN 0 AND 31536000),
  state text NOT NULL CHECK (state IN ('queued','leased','retry_wait','ready','failed','cancelled')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 8),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 8),
  lease_token text CHECK (lease_token IS NULL OR lease_token ~ '^[0-9a-f]{64}$'),
  lease_until timestamptz,
  next_retry_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (source_locale <> target_locale),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state = 'leased' OR lease_token IS NULL),
  CHECK (state = 'leased' OR lease_until IS NULL),
  CHECK (state <> 'retry_wait' OR next_retry_at IS NOT NULL),
  UNIQUE(source_kind,letter_id,source_revision_id,source_revision,source_hash,source_locale,target_locale,provider_id,provider_version,consent_id),
  UNIQUE(owner_id,key_digest)
);
CREATE INDEX translation_tasks_claim_idx ON translation.tasks(state,next_retry_at,lease_until,created_at);
CREATE INDEX translation_tasks_letter_idx ON translation.tasks(letter_id,source_revision_id,target_locale);

-- PostgreSQL-owned wake intents. BullMQ is only a delivery accelerator: an
-- unmarked row survives a crash between the task commit and queue.add().
CREATE TABLE translation.retry_wakeups (
  task_id uuid PRIMARY KEY REFERENCES translation.tasks(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 0),
  next_retry_at timestamptz NOT NULL,
  enqueued_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX translation_retry_wakeups_due_idx
  ON translation.retry_wakeups(next_retry_at,enqueued_at,task_id);
INSERT INTO translation.retry_wakeups(task_id,attempt,next_retry_at,enqueued_at,created_at)
SELECT id,attempts,COALESCE(next_retry_at,created_at),NULL,created_at
  FROM translation.tasks
 WHERE state IN ('queued','retry_wait');

CREATE TABLE translation.results (
  task_id uuid PRIMARY KEY REFERENCES translation.tasks(id) ON DELETE CASCADE,
  title_ciphertext text NOT NULL,
  title_nonce text NOT NULL,
  body_ciphertext text NOT NULL,
  body_nonce text NOT NULL,
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL
);

CREATE TABLE translation.consents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind = 'private_letter'),
  letter_id uuid NOT NULL REFERENCES letters.letters(id) ON DELETE CASCADE,
  source_revision_id uuid NOT NULL REFERENCES letters.letter_revisions(id) ON DELETE CASCADE,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  processing_region text NOT NULL CHECK (length(processing_region) BETWEEN 1 AND 64),
  retention_policy text NOT NULL CHECK (retention_policy IN ('zero','ephemeral','bounded')),
  provider_version text NOT NULL DEFAULT 'unknown' CHECK (length(provider_version) BETWEEN 1 AND 128),
  retention_seconds integer NOT NULL DEFAULT 0 CHECK (retention_seconds BETWEEN 0 AND 31536000),
  capability text NOT NULL CHECK (capability = 'private_translation'),
  no_training boolean NOT NULL CHECK (no_training),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE(id)
);
CREATE INDEX translation_consents_lookup_idx ON translation.consents(owner_id,letter_id,source_revision_id,provider_id,expires_at,revoked_at);
CREATE INDEX translation_consents_binding_idx ON translation.consents(owner_id,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,expires_at,revoked_at);
CREATE UNIQUE INDEX translation_consents_active_exact_unique
  ON translation.consents(owner_id,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds)
  WHERE revoked_at IS NULL;

CREATE TABLE translation.idempotency_keys (
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id,key_digest)
);

CREATE OR REPLACE FUNCTION translation.source_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  revision_letter_id uuid;
  revision_number integer;
  revision_hash text;
  letter_kind text;
BEGIN
  SELECT r.letter_id,r.revision,r.source_hash,l.kind INTO revision_letter_id,revision_number,revision_hash,letter_kind
    FROM letters.letter_revisions r JOIN letters.letters l ON l.id=r.letter_id
   WHERE r.id=NEW.source_revision_id;
  IF revision_letter_id IS NULL
     OR revision_letter_id <> NEW.letter_id
     OR revision_number <> NEW.source_revision
     OR revision_hash <> NEW.source_hash
     OR letter_kind <> NEW.source_kind
     OR (NEW.source_kind='private_letter' AND NOT EXISTS (
       SELECT 1 FROM letters.letters l WHERE l.id=NEW.letter_id AND l.owner_id=NEW.owner_id
     )) THEN
    RAISE EXCEPTION 'translation source binding is invalid';
  END IF;
  IF NEW.source_kind='public_letter' AND NOT EXISTS (
    SELECT 1 FROM letters.publications p JOIN letters.letters l ON l.id=p.letter_id
      WHERE p.letter_id=NEW.letter_id AND p.revision_id=NEW.source_revision_id
        AND p.source_hash=NEW.source_hash AND l.state='published'
        AND l.current_revision=NEW.source_revision
  ) THEN
    RAISE EXCEPTION 'public translation source is not published';
  END IF;
  IF NEW.source_kind='private_letter' AND NOT EXISTS (
    SELECT 1 FROM translation.consents c
     WHERE c.id=NEW.consent_id AND c.owner_id=NEW.owner_id AND c.letter_id=NEW.letter_id
       AND c.source_revision_id=NEW.source_revision_id AND c.source_hash=NEW.source_hash
       AND c.provider_id=NEW.provider_id AND c.provider_version=NEW.consent_provider_version
       AND c.processing_region=NEW.consent_processing_region
       AND c.retention_policy=NEW.consent_retention_policy
       AND c.retention_seconds=NEW.consent_retention_seconds
       AND c.revoked_at IS NULL AND c.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'private translation consent binding is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION translation.task_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.letter_id IS DISTINCT FROM OLD.letter_id
     OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
     OR NEW.source_locale IS DISTINCT FROM OLD.source_locale
     OR NEW.target_locale IS DISTINCT FROM OLD.target_locale
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.provider_version IS DISTINCT FROM OLD.provider_version
     OR NEW.key_digest IS DISTINCT FROM OLD.key_digest
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.consent_provider_version IS DISTINCT FROM OLD.consent_provider_version
     OR NEW.consent_id IS DISTINCT FROM OLD.consent_id
     OR NEW.consent_processing_region IS DISTINCT FROM OLD.consent_processing_region
     OR NEW.consent_retention_policy IS DISTINCT FROM OLD.consent_retention_policy
     OR NEW.consent_retention_seconds IS DISTINCT FROM OLD.consent_retention_seconds
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
    RAISE EXCEPTION 'translation task identity is immutable';
  END IF;
  IF OLD.state IN ('ready','failed','cancelled') THEN
    RAISE EXCEPTION 'translation terminal task is immutable';
  END IF;
  IF NOT ((OLD.state IN ('queued','retry_wait') AND NEW.state='leased')
       OR (OLD.state='leased' AND NEW.state IN ('ready','retry_wait','failed','cancelled'))
       OR (OLD.state='leased' AND NEW.state='leased' AND OLD.lease_until <= clock_timestamp())) THEN
    RAISE EXCEPTION 'translation state transition is invalid';
  END IF;
  IF NEW.state='leased' THEN
    IF NEW.attempts <> OLD.attempts + 1 OR NEW.lease_token IS NULL OR NEW.lease_until IS NULL
       OR (OLD.state='leased' AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token)
       OR NEW.next_retry_at IS NOT NULL THEN
      RAISE EXCEPTION 'translation lease transition is invalid';
    END IF;
  ELSE
    IF NEW.attempts <> OLD.attempts OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
      RAISE EXCEPTION 'translation lease must be released';
    END IF;
  END IF;
  IF NEW.state='ready' AND (NEW.next_retry_at IS NOT NULL OR NEW.last_error_code IS NOT NULL) THEN
    RAISE EXCEPTION 'ready translation has terminal fields';
  END IF;
  IF NEW.state='retry_wait' AND (NEW.next_retry_at IS NULL OR NEW.last_error_code IS NULL) THEN
    RAISE EXCEPTION 'retry translation has invalid fields';
  END IF;
  IF NEW.state='failed' AND (NEW.next_retry_at IS NOT NULL OR NEW.last_error_code IS NULL) THEN
    RAISE EXCEPTION 'failed translation has invalid fields';
  END IF;
  IF NEW.state='cancelled' AND NEW.next_retry_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancelled translation has retry field';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'translation updated_at cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION translation.consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.letter_id IS DISTINCT FROM OLD.letter_id
     OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.processing_region IS DISTINCT FROM OLD.processing_region
     OR NEW.provider_version IS DISTINCT FROM OLD.provider_version OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy
     OR NEW.retention_seconds IS DISTINCT FROM OLD.retention_seconds OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.no_training IS DISTINCT FROM OLD.no_training OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR NEW.revoked_at < OLD.created_at OR NEW.revoked_at > clock_timestamp() THEN
    RAISE EXCEPTION 'translation consent is immutable except revoke';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION translation.task_initial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'queued' OR NEW.attempts <> 0 OR NEW.lease_token IS NOT NULL
     OR NEW.lease_until IS NOT NULL OR NEW.next_retry_at IS NOT NULL
     OR NEW.last_error_code IS NOT NULL OR NEW.max_attempts NOT BETWEEN 1 AND 8
     OR NEW.updated_at < NEW.created_at THEN
    RAISE EXCEPTION 'translation task initial state is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION translation.consent_initial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  revision_letter_id uuid;
  revision_number integer;
  revision_hash text;
  letter_owner uuid;
  letter_kind text;
BEGIN
  SELECT r.letter_id,r.revision,r.source_hash,l.owner_id,l.kind
    INTO revision_letter_id,revision_number,revision_hash,letter_owner,letter_kind
    FROM letters.letter_revisions r JOIN letters.letters l ON l.id=r.letter_id
   WHERE r.id=NEW.source_revision_id;
  IF NEW.source_kind <> 'private_letter' OR NEW.revoked_at IS NOT NULL
     OR NEW.expires_at <= NEW.created_at
     OR revision_letter_id IS NULL OR revision_letter_id <> NEW.letter_id
     OR revision_hash <> NEW.source_hash OR letter_owner <> NEW.owner_id
     OR letter_kind <> 'private_letter' THEN
    RAISE EXCEPTION 'translation consent binding is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION translation.result_initial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_state text;
  task_lease_until timestamptz;
  task_lease_token text;
BEGIN
  SELECT state,lease_until,lease_token INTO task_state,task_lease_until,task_lease_token
    FROM translation.tasks WHERE id=NEW.task_id FOR KEY SHARE;
  IF task_state IS DISTINCT FROM 'leased' OR task_lease_token IS NULL OR task_lease_until <= clock_timestamp()
     OR EXISTS (SELECT 1 FROM translation.results WHERE task_id=NEW.task_id) THEN
    RAISE EXCEPTION 'translation result requires leased task';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION translation.append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'translation immutable record cannot be changed';
END;
$$;

CREATE OR REPLACE FUNCTION translation.idempotency_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
   IF NEW.result_json ? 'task' AND NOT EXISTS (
     SELECT 1 FROM translation.tasks t
      WHERE t.id=(NEW.result_json->'task'->>'id')::uuid
        AND (t.source_kind='public_letter' OR t.owner_id=NEW.owner_id)
   ) THEN
    RAISE EXCEPTION 'translation idempotency result is not bound to task';
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'translation idempotency result is invalid';
END;
$$;

CREATE TRIGGER translation_source_binding BEFORE INSERT OR UPDATE OF source_kind,letter_id,source_revision_id,source_revision,source_hash ON translation.tasks FOR EACH ROW EXECUTE FUNCTION translation.source_binding_guard();
CREATE TRIGGER translation_task_initial BEFORE INSERT ON translation.tasks FOR EACH ROW EXECUTE FUNCTION translation.task_initial_guard();
CREATE TRIGGER translation_task_transition BEFORE UPDATE ON translation.tasks FOR EACH ROW EXECUTE FUNCTION translation.task_transition_guard();
CREATE TRIGGER translation_consents_initial BEFORE INSERT ON translation.consents FOR EACH ROW EXECUTE FUNCTION translation.consent_initial_guard();
CREATE TRIGGER translation_consents_revoke BEFORE UPDATE ON translation.consents FOR EACH ROW EXECUTE FUNCTION translation.consent_guard();
CREATE TRIGGER translation_consents_append_only BEFORE DELETE ON translation.consents FOR EACH ROW EXECUTE FUNCTION translation.append_only_guard();
CREATE TRIGGER translation_results_initial BEFORE INSERT ON translation.results FOR EACH ROW EXECUTE FUNCTION translation.result_initial_guard();
CREATE TRIGGER translation_results_append_only BEFORE UPDATE OR DELETE ON translation.results FOR EACH ROW EXECUTE FUNCTION translation.append_only_guard();
CREATE TRIGGER translation_idempotency_append_only BEFORE UPDATE OR DELETE ON translation.idempotency_keys FOR EACH ROW EXECUTE FUNCTION translation.append_only_guard();
CREATE TRIGGER translation_idempotency_insert BEFORE INSERT ON translation.idempotency_keys FOR EACH ROW EXECUTE FUNCTION translation.idempotency_insert_guard();

-- +END UP
-- +BEGIN DOWN
DROP TRIGGER IF EXISTS translation_idempotency_append_only ON translation.idempotency_keys;
DROP TRIGGER IF EXISTS translation_idempotency_insert ON translation.idempotency_keys;
DROP INDEX IF EXISTS translation_consents_active_exact_unique;
DROP TABLE IF EXISTS translation.retry_wakeups;
DROP TRIGGER IF EXISTS translation_results_append_only ON translation.results;
DROP TRIGGER IF EXISTS translation_results_initial ON translation.results;
DROP TRIGGER IF EXISTS translation_consents_revoke ON translation.consents;
DROP TRIGGER IF EXISTS translation_consents_append_only ON translation.consents;
DROP TRIGGER IF EXISTS translation_consents_initial ON translation.consents;
DROP TRIGGER IF EXISTS translation_task_transition ON translation.tasks;
DROP TRIGGER IF EXISTS translation_task_initial ON translation.tasks;
DROP TRIGGER IF EXISTS translation_source_binding ON translation.tasks;
DROP FUNCTION IF EXISTS translation.append_only_guard();
DROP FUNCTION IF EXISTS translation.idempotency_insert_guard();
DROP FUNCTION IF EXISTS translation.result_initial_guard();
DROP FUNCTION IF EXISTS translation.consent_initial_guard();
DROP FUNCTION IF EXISTS translation.task_initial_guard();
DROP FUNCTION IF EXISTS translation.consent_guard();
DROP FUNCTION IF EXISTS translation.task_transition_guard();
DROP FUNCTION IF EXISTS translation.source_binding_guard();
DROP TABLE IF EXISTS translation.idempotency_keys;
DROP TABLE IF EXISTS translation.consents;
DROP TABLE IF EXISTS translation.results;
DROP TABLE IF EXISTS translation.tasks;
DROP SCHEMA IF EXISTS translation;
-- +END DOWN
