-- MED-01 secure media pipeline. Client filenames, URLs, access tokens and
-- original bytes are deliberately absent; only keyed object-reference digests
-- and safe processing metadata are persisted.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS media;

CREATE TABLE media.assets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('profile_avatar','profile_gallery')),
  state text NOT NULL CHECK (state IN ('reserved','uploaded','scanning','sanitizing','clean','rejected','retryable','deleted','held')),
  declared_size bigint NOT NULL CHECK (declared_size >= 0 AND declared_size <= 26214400),
  declared_content_type text,
  detected_type text CHECK (detected_type IS NULL OR detected_type IN ('image/jpeg','image/png','image/webp')),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  retention_state text NOT NULL DEFAULT 'active' CHECK (retention_state IN ('active','deleted','held')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  legal_hold_at timestamptz,
  CHECK ((retention_state <> 'held') OR legal_hold_at IS NOT NULL),
  CHECK ((state <> 'held') OR retention_state = 'held'),
  CHECK ((state = 'deleted') = (retention_state = 'deleted')),
  CHECK ((state <> 'deleted') OR deleted_at IS NOT NULL)
);
CREATE INDEX media_assets_owner_state_idx ON media.assets(owner_id, state);

CREATE TABLE media.upload_intents (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL UNIQUE REFERENCES media.assets(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  idempotency_digest text NOT NULL UNIQUE CHECK (idempotency_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  complete_idempotency_digest text CHECK (complete_idempotency_digest IS NULL OR complete_idempotency_digest ~ '^[0-9a-f]{64}$'),
  complete_payload_digest text CHECK (complete_payload_digest IS NULL OR complete_payload_digest ~ '^[0-9a-f]{64}$'),
  quarantine_key_digest text NOT NULL UNIQUE CHECK (quarantine_key_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX media_upload_intents_owner_idx ON media.upload_intents(owner_id, created_at);

CREATE TABLE media.processing_jobs (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.assets(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('scan','sanitize','publish')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  status text NOT NULL CHECK (status IN ('queued','claimed','completed','retryable','failed')),
  lease_token uuid,
  lease_until timestamptz,
  worker_id text,
  safe_error text CHECK (safe_error IS NULL OR safe_error IN ('SIZE_LIMIT','UNSUPPORTED_TYPE','MAGIC_MISMATCH','TRUNCATED_IMAGE','ANIMATED_IMAGE','MULTIPAGE_IMAGE','POLYGLOT','MALWARE_DETECTED','SCANNER_UNAVAILABLE','SCANNER_TIMEOUT','SANITIZER_FAILED','SANITIZER_LIMIT','OBJECT_MISMATCH','EXPIRED_INTENT','ACCESS_DENIED','LEGAL_HOLD')),
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(asset_id, stage),
  CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX media_jobs_claim_idx ON media.processing_jobs(status, next_retry_at, lease_until, created_at);

CREATE TABLE media.renditions (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.assets(id) ON DELETE CASCADE,
  variant text NOT NULL CHECK (variant = 'clean'),
  clean_key_digest text NOT NULL UNIQUE CHECK (clean_key_digest ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 26214400),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  sanitizer_version text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(asset_id, variant)
);

CREATE TABLE media.access_audit (
  id bigserial PRIMARY KEY,
  asset_id uuid REFERENCES media.assets(id) ON DELETE SET NULL,
  viewer_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  purpose text NOT NULL CHECK (purpose IN ('profile_avatar','profile_gallery')),
  outcome text NOT NULL CHECK (outcome IN ('allowed','denied')),
  reason_code text NOT NULL CHECK (reason_code IN ('AUTHORIZED','NOT_CLEAN','NOT_FOUND','IDOR_DENIED','EXPIRED','HELD','DELETED')),
  created_at timestamptz NOT NULL
);
CREATE INDEX media_access_audit_asset_idx ON media.access_audit(asset_id, created_at);

CREATE OR REPLACE FUNCTION media.prevent_access_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'media access audit is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER media_access_audit_append_only
  BEFORE UPDATE OR DELETE ON media.access_audit FOR EACH ROW EXECUTE FUNCTION media.prevent_access_audit_mutation();

CREATE OR REPLACE FUNCTION media.guard_asset_retention() RETURNS trigger AS $$
BEGIN
  IF OLD.retention_state = 'held' AND NEW.retention_state <> 'held' THEN
    RAISE EXCEPTION 'media legal hold is immutable until explicit release';
  END IF;
  IF OLD.state IN ('deleted','held') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'terminal media state cannot be reopened';
  END IF;
  -- Retention actions are explicit global transitions, independent of the
  -- processing lifecycle.  Ordinary deletion never changes a legal hold.
  IF OLD.retention_state <> 'held' AND NEW.state IN ('deleted','held') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'reserved' AND NEW.state NOT IN ('reserved','uploaded','rejected') THEN
    RAISE EXCEPTION 'invalid media state transition';
  END IF;
  IF OLD.state = 'uploaded' AND NEW.state NOT IN ('uploaded','scanning','rejected','retryable') THEN
    RAISE EXCEPTION 'invalid media state transition';
  END IF;
  IF OLD.state = 'scanning' AND NEW.state NOT IN ('scanning','sanitizing','rejected','retryable') THEN
    RAISE EXCEPTION 'invalid media state transition';
  END IF;
  IF OLD.state = 'sanitizing' AND NEW.state NOT IN ('sanitizing','clean','rejected','retryable') THEN
    RAISE EXCEPTION 'invalid media state transition';
  END IF;
  IF OLD.state = 'retryable' AND NEW.state NOT IN ('retryable','scanning','sanitizing','rejected') THEN
    RAISE EXCEPTION 'invalid media state transition';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER media_assets_retention_guard
  BEFORE UPDATE ON media.assets FOR EACH ROW EXECUTE FUNCTION media.guard_asset_retention();

-- +END UP

-- +BEGIN DOWN
DROP TRIGGER IF EXISTS media_access_audit_append_only ON media.access_audit;
DROP FUNCTION IF EXISTS media.prevent_access_audit_mutation();
DROP TRIGGER IF EXISTS media_assets_retention_guard ON media.assets;
DROP FUNCTION IF EXISTS media.guard_asset_retention();
DROP TABLE IF EXISTS media.access_audit;
DROP TABLE IF EXISTS media.renditions;
DROP TABLE IF EXISTS media.processing_jobs;
DROP TABLE IF EXISTS media.upload_intents;
DROP TABLE IF EXISTS media.assets;
DROP SCHEMA IF EXISTS media;
-- +END DOWN
