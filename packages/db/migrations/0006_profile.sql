-- PRF-01 profile facts, independent matching use and member audience.
-- Values that are sensitive or AI-only are AES-GCM ciphertext; the DB never
-- receives DOB, documents, exact location or model-derived gender facts.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS profile;

CREATE TABLE profile.profiles (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES iam.accounts(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  city text CHECK (city IS NULL OR length(city) BETWEEN 1 AND 80),
  country_code text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  state text NOT NULL CHECK (state IN ('draft','active','paused','deleted')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE profile.fact_definitions (
  fact_key text PRIMARY KEY CHECK (fact_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  value_kind text NOT NULL CHECK (value_kind IN ('text','boolean','enum','media_ref','number')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('low','sensitive','ai_only')),
  allowed_modes text[] NOT NULL CHECK (cardinality(allowed_modes) > 0 AND allowed_modes <@ ARRAY['friends','activities','professional','circles','events','dating']),
  default_audience text NOT NULL CHECK (default_audience IN ('self','verified_members','connections','nobody')),
  ai_only boolean NOT NULL DEFAULT false,
  policy_version text NOT NULL,
  CHECK ((sensitivity = 'ai_only') = ai_only)
);

INSERT INTO profile.fact_definitions
  (fact_key,value_kind,sensitivity,allowed_modes,default_audience,ai_only,policy_version)
VALUES
  ('about_me','text','low',ARRAY['friends','activities','professional','circles','events','dating'],'verified_members',false,'prf-1'),
  ('interests','text','low',ARRAY['friends','activities','professional','circles','events','dating'],'verified_members',false,'prf-1'),
  ('availability','text','sensitive',ARRAY['professional','events'],'connections',false,'prf-1'),
  ('ai_profile_summary','text','ai_only',ARRAY['friends','activities','professional','circles','events','dating'],'nobody',true,'prf-1');

CREATE TABLE profile.profile_facts (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profile.profiles(id) ON DELETE CASCADE,
  fact_key text NOT NULL REFERENCES profile.fact_definitions(fact_key),
  state text NOT NULL CHECK (state IN ('proposed','confirmed','withdrawn')),
  source text NOT NULL CHECK (source IN ('user_confirmed','approved_draft')),
  value_json jsonb,
  value_ciphertext text,
  value_nonce text,
  value_key_id text,
  confirmed_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE(profile_id, fact_key),
  CHECK ((value_ciphertext IS NULL AND value_nonce IS NULL AND value_key_id IS NULL)
      OR (value_ciphertext IS NOT NULL AND value_nonce IS NOT NULL AND value_key_id IS NOT NULL)),
  CHECK ((value_json IS NOT NULL)::integer + (value_ciphertext IS NOT NULL)::integer = 1)
);

CREATE OR REPLACE FUNCTION profile.validate_fact_storage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sensitive text;
BEGIN
  SELECT d.sensitivity INTO sensitive FROM profile.fact_definitions d WHERE d.fact_key = NEW.fact_key;
  IF sensitive IN ('sensitive','ai_only') AND NEW.value_json IS NOT NULL THEN
    RAISE EXCEPTION 'sensitive profile facts require encrypted storage';
  END IF;
  IF sensitive = 'low' AND NEW.value_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'low profile facts must use JSON storage';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profile_fact_storage_policy
  BEFORE INSERT OR UPDATE ON profile.profile_facts
  FOR EACH ROW EXECUTE FUNCTION profile.validate_fact_storage();

CREATE TABLE profile.fact_uses (
  profile_id uuid NOT NULL REFERENCES profile.profiles(id) ON DELETE CASCADE,
  fact_key text NOT NULL REFERENCES profile.fact_definitions(fact_key),
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  matching_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (profile_id, fact_key, mode)
);

CREATE TABLE profile.fact_audiences (
  profile_id uuid NOT NULL REFERENCES profile.profiles(id) ON DELETE CASCADE,
  fact_key text NOT NULL REFERENCES profile.fact_definitions(fact_key),
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  audience text NOT NULL CHECK (audience IN ('self','verified_members','connections','nobody')),
  age_partition text NOT NULL CHECK (age_partition IN ('unknown','youth','adult')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (profile_id, fact_key, mode)
);

CREATE OR REPLACE FUNCTION profile.validate_fact_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  SELECT d.allowed_modes INTO allowed
    FROM profile.fact_definitions d
   WHERE d.fact_key = NEW.fact_key;
  IF allowed IS NULL OR NOT (NEW.mode = ANY (allowed)) THEN
    RAISE EXCEPTION 'profile fact mode is not allowed for this definition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_uses_allowed_mode
  BEFORE INSERT OR UPDATE ON profile.fact_uses
  FOR EACH ROW EXECUTE FUNCTION profile.validate_fact_mode();
CREATE TRIGGER fact_audiences_allowed_mode
  BEFORE INSERT OR UPDATE ON profile.fact_audiences
  FOR EACH ROW EXECUTE FUNCTION profile.validate_fact_mode();

CREATE TABLE profile.snapshots (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profile.profiles(id) ON DELETE CASCADE,
  profile_version integer NOT NULL CHECK (profile_version >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  UNIQUE(profile_id, profile_version),
  UNIQUE(profile_id, content_hash)
);

CREATE TABLE profile.idempotency_keys (
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  idempotency_key_digest text NOT NULL CHECK (idempotency_key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, idempotency_key_digest)
);

CREATE TABLE profile.sensitive_access_audit (
  id bigserial PRIMARY KEY,
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE RESTRICT,
  subject_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE RESTRICT,
  fact_key text NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 100),
  decision text NOT NULL CHECK (decision IN ('allow','deny')),
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX profile_facts_profile_idx ON profile.profile_facts(profile_id);
CREATE INDEX profile_snapshots_profile_published_idx ON profile.snapshots(profile_id, published_at DESC);
CREATE INDEX profile_sensitive_audit_subject_idx ON profile.sensitive_access_audit(subject_account_id, created_at);

CREATE OR REPLACE FUNCTION profile.reject_sensitive_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'profile sensitive access audit is append-only';
END;
$$;
CREATE TRIGGER sensitive_access_audit_immutable
  BEFORE UPDATE OR DELETE ON profile.sensitive_access_audit
  FOR EACH ROW EXECUTE FUNCTION profile.reject_sensitive_audit_mutation();

-- +END UP
-- +BEGIN DOWN
DROP SCHEMA IF EXISTS profile CASCADE;
-- +END DOWN
