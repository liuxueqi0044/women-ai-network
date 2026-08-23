-- LTR-01 encrypted letter drafts, immutable revisions and member publication.
-- The original revision is canonical; the publication is a minimal member-safe
-- projection and is never exposed anonymously.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS letters;

CREATE TABLE letters.letters (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('public_letter','private_letter')),
  state text NOT NULL CHECK (state IN ('draft','published','withdrawn','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_at timestamptz,
  withdrawn_at timestamptz,
  archived_at timestamptz,
  CHECK (kind = 'public_letter' OR state <> 'published'),
  CHECK (state <> 'published' OR (published_at IS NOT NULL AND withdrawn_at IS NULL)),
  CHECK (state <> 'withdrawn' OR withdrawn_at IS NOT NULL),
  CHECK (state <> 'archived' OR archived_at IS NOT NULL)
);
CREATE INDEX letters_owner_state_idx ON letters.letters(owner_id, state, updated_at DESC);
CREATE INDEX letters_owner_cursor_idx ON letters.letters(owner_id, created_at DESC, id DESC);

CREATE TABLE letters.letter_revisions (
  id uuid PRIMARY KEY,
  letter_id uuid NOT NULL REFERENCES letters.letters(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  title_ciphertext text NOT NULL,
  title_nonce text NOT NULL,
  body_ciphertext text NOT NULL,
  body_nonce text NOT NULL,
  metadata_ciphertext text NOT NULL,
  metadata_nonce text NOT NULL,
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL,
  UNIQUE(letter_id, revision)
);
CREATE INDEX letters_revisions_letter_idx ON letters.letter_revisions(letter_id, revision DESC);
CREATE INDEX letters_revisions_source_hash_idx ON letters.letter_revisions(letter_id, source_hash);

CREATE TABLE letters.publications (
  id uuid PRIMARY KEY,
  letter_id uuid NOT NULL UNIQUE REFERENCES letters.letters(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL UNIQUE REFERENCES letters.letter_revisions(id) ON DELETE RESTRICT,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  projection_json jsonb NOT NULL CHECK (jsonb_typeof(projection_json) = 'object'),
  published_at timestamptz NOT NULL
);

CREATE TABLE letters.idempotency_keys (
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id, key_digest)
);

CREATE TABLE letters.audit_events (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  letter_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('letter.created','letter.autosaved','letter.published','letter.withdrawn','letter.archived')),
  metadata_json jsonb NOT NULL CHECK (
    jsonb_typeof(metadata_json) = 'object'
    AND metadata_json::text NOT ILIKE '%body%'
    AND metadata_json::text NOT ILIKE '%title%'
  ),
  created_at timestamptz NOT NULL
);
CREATE INDEX letters_audit_letter_idx ON letters.audit_events(letter_id, created_at);

CREATE OR REPLACE FUNCTION letters.append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Account/letter erasure may cascade dependent content; direct mutation of
  -- an immutable row remains forbidden at trigger depth 1.
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'letters append-only record cannot be changed';
END;
$$;
CREATE OR REPLACE FUNCTION letters.publication_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  revision_letter_id uuid;
  revision_source_hash text;
  revision_number integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM letters.letters l WHERE l.id = NEW.letter_id AND l.kind = 'public_letter' AND l.state = 'published') THEN
    RAISE EXCEPTION 'only published public letters may have a publication';
  END IF;
  SELECT r.letter_id, r.source_hash, r.revision
    INTO revision_letter_id, revision_source_hash, revision_number
    FROM letters.letter_revisions r WHERE r.id = NEW.revision_id;
  IF revision_letter_id IS NULL
     OR revision_letter_id <> NEW.letter_id
     OR revision_source_hash IS DISTINCT FROM NEW.source_hash THEN
    RAISE EXCEPTION 'publication revision binding is invalid';
  END IF;
  IF NEW.projection_json->>'id' IS DISTINCT FROM NEW.letter_id::text
     OR NEW.projection_json->>'revision' IS DISTINCT FROM revision_number::text THEN
    RAISE EXCEPTION 'publication projection binding is invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION letters.letter_identity_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'letter identity is immutable';
  END IF;
  IF NEW.current_revision <> OLD.current_revision THEN
    IF OLD.state <> 'draft'
       OR NEW.state <> 'draft'
       OR NEW.current_revision <> OLD.current_revision + 1
       OR NEW.version <> OLD.version + 1
       OR NEW.updated_at < OLD.updated_at
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
       OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
       OR NOT EXISTS (
         SELECT 1 FROM letters.letter_revisions r
          WHERE r.letter_id = NEW.id AND r.revision = NEW.current_revision
       ) THEN
      RAISE EXCEPTION 'letter revision transition is invalid';
    END IF;
  ELSIF NEW.state = OLD.state THEN
    IF NEW.version <> OLD.version OR NEW.current_revision <> OLD.current_revision
       OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
       OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
      RAISE EXCEPTION 'letter version transition is invalid';
    END IF;
  ELSE
    IF NEW.version <> OLD.version + 1 OR NEW.current_revision <> OLD.current_revision
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'letter state transition version is invalid';
    END IF;
    IF NOT (
      (OLD.state = 'draft' AND NEW.state IN ('published', 'archived'))
      OR (OLD.state = 'published' AND NEW.state = 'withdrawn')
      OR (OLD.state = 'withdrawn' AND NEW.state = 'archived')
    ) THEN
      RAISE EXCEPTION 'letter state transition is invalid';
    END IF;
    IF OLD.state = 'draft' AND NEW.state = 'published'
       AND (OLD.published_at IS NOT NULL OR NEW.published_at IS NULL
         OR NEW.withdrawn_at IS NOT NULL OR NEW.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'published timestamp transition is invalid';
    END IF;
    IF OLD.state = 'published' AND NEW.state = 'withdrawn'
       AND (NEW.published_at IS DISTINCT FROM OLD.published_at
         OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
         OR NEW.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'withdrawn timestamp transition is invalid';
    END IF;
    IF NEW.state = 'archived'
       AND (OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL
         OR NEW.published_at IS DISTINCT FROM OLD.published_at
         OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
      RAISE EXCEPTION 'archived timestamp transition is invalid';
    END IF;
  END IF;
  IF NEW.state = 'published' AND (NEW.kind <> 'public_letter' OR NEW.published_at IS NULL OR NEW.withdrawn_at IS NOT NULL OR NEW.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'published letter terminal fields are invalid';
  END IF;
  IF NEW.state = 'withdrawn' AND (NEW.published_at IS NULL OR NEW.withdrawn_at IS NULL OR NEW.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'withdrawn letter terminal fields are invalid';
  END IF;
  IF NEW.state = 'archived' AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'archived letter terminal fields are invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION letters.letter_initial_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'draft'
     OR NEW.version <> 1
     OR NEW.current_revision <> 1
     OR NEW.published_at IS NOT NULL
     OR NEW.withdrawn_at IS NOT NULL
     OR NEW.archived_at IS NOT NULL
     OR NEW.updated_at < NEW.created_at THEN
    RAISE EXCEPTION 'letter initial state is invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION letters.revision_sequence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_revision integer;
  existing_count integer;
BEGIN
  SELECT l.current_revision INTO current_revision FROM letters.letters l WHERE l.id = NEW.letter_id;
  SELECT count(*)::integer INTO existing_count FROM letters.letter_revisions r WHERE r.letter_id = NEW.letter_id;
  IF current_revision IS NULL OR (existing_count = 0 AND NEW.revision <> 1) OR (existing_count > 0 AND NEW.revision <> current_revision + 1) THEN
    RAISE EXCEPTION 'letter revision sequence is invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION letters.initial_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM letters.letter_revisions r
     WHERE r.letter_id = NEW.id AND r.revision = 1
  ) THEN
    RAISE EXCEPTION 'letter initial revision is missing';
  END IF;
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION letters.revision_current_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_revision integer;
  max_revision integer;
BEGIN
  SELECT l.current_revision INTO current_revision FROM letters.letters l WHERE l.id = NEW.letter_id;
  SELECT max(r.revision) INTO max_revision FROM letters.letter_revisions r WHERE r.letter_id = NEW.letter_id;
  IF current_revision IS DISTINCT FROM max_revision THEN
    RAISE EXCEPTION 'letter current revision does not match revisions';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER letters_identity_transition
  BEFORE UPDATE ON letters.letters
  FOR EACH ROW EXECUTE FUNCTION letters.letter_identity_transition_guard();
CREATE TRIGGER letters_initial_state
  BEFORE INSERT ON letters.letters
  FOR EACH ROW EXECUTE FUNCTION letters.letter_initial_state_guard();
CREATE TRIGGER letters_revision_sequence
  BEFORE INSERT ON letters.letter_revisions
  FOR EACH ROW EXECUTE FUNCTION letters.revision_sequence_guard();
CREATE CONSTRAINT TRIGGER letters_initial_revision
  AFTER INSERT ON letters.letters
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION letters.initial_revision_guard();
CREATE CONSTRAINT TRIGGER letters_revision_current
  AFTER INSERT ON letters.letter_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION letters.revision_current_guard();
CREATE TRIGGER letters_publication_policy
  BEFORE INSERT ON letters.publications
  FOR EACH ROW EXECUTE FUNCTION letters.publication_policy_guard();
CREATE TRIGGER letters_revisions_append_only
  BEFORE UPDATE OR DELETE ON letters.letter_revisions
  FOR EACH ROW EXECUTE FUNCTION letters.append_only_guard();
CREATE TRIGGER letters_publications_append_only
  BEFORE UPDATE OR DELETE ON letters.publications
  FOR EACH ROW EXECUTE FUNCTION letters.append_only_guard();
CREATE TRIGGER letters_audit_append_only
  BEFORE UPDATE OR DELETE ON letters.audit_events
  FOR EACH ROW EXECUTE FUNCTION letters.append_only_guard();

-- +END UP
-- +BEGIN DOWN
DROP TRIGGER IF EXISTS letters_audit_append_only ON letters.audit_events;
DROP TRIGGER IF EXISTS letters_publication_policy ON letters.publications;
DROP TRIGGER IF EXISTS letters_publications_append_only ON letters.publications;
DROP TRIGGER IF EXISTS letters_revisions_append_only ON letters.letter_revisions;
DROP TRIGGER IF EXISTS letters_revision_current ON letters.letter_revisions;
DROP TRIGGER IF EXISTS letters_initial_revision ON letters.letters;
DROP TRIGGER IF EXISTS letters_revision_sequence ON letters.letter_revisions;
DROP TRIGGER IF EXISTS letters_identity_transition ON letters.letters;
DROP TRIGGER IF EXISTS letters_initial_state ON letters.letters;
DROP FUNCTION IF EXISTS letters.append_only_guard();
DROP FUNCTION IF EXISTS letters.publication_policy_guard();
DROP FUNCTION IF EXISTS letters.letter_identity_transition_guard();
DROP FUNCTION IF EXISTS letters.letter_initial_state_guard();
DROP FUNCTION IF EXISTS letters.initial_revision_guard();
DROP FUNCTION IF EXISTS letters.revision_sequence_guard();
DROP FUNCTION IF EXISTS letters.revision_current_guard();
DROP TABLE IF EXISTS letters.audit_events;
DROP TABLE IF EXISTS letters.idempotency_keys;
DROP TABLE IF EXISTS letters.publications;
DROP TABLE IF EXISTS letters.letter_revisions;
DROP TABLE IF EXISTS letters.letters;
DROP SCHEMA IF EXISTS letters;
-- +END DOWN
