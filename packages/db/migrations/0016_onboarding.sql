-- ONB-01: manual-first intent and preference onboarding.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS onboarding;
CREATE TABLE onboarding.interview_sessions (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('discovery','profile')),
  modes text[] NOT NULL CHECK (cardinality(modes)>0 AND modes <@ ARRAY['friends','activities','professional','circles','events','dating']),
  dating_enabled boolean NOT NULL, state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','withdrawn')),
  modes_version integer NOT NULL DEFAULT 1 CHECK (modes_version>0), version integer NOT NULL DEFAULT 0 CHECK (version>=0), answer_revision integer NOT NULL DEFAULT 0 CHECK (answer_revision>=0),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CHECK ((dating_enabled AND 'dating'=ANY(modes)) OR (NOT dating_enabled AND NOT ('dating'=ANY(modes)))
));
CREATE UNIQUE INDEX onboarding_active_session_unique ON onboarding.interview_sessions(account_id,purpose) WHERE state='active';
CREATE TABLE onboarding.answer_revisions (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES onboarding.interview_sessions(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('discovery','profile')), mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  revision integer NOT NULL CHECK (revision>0), answer_ciphertext text NOT NULL, answer_nonce text NOT NULL, answer_key_id text NOT NULL,
  answer_hash text NOT NULL CHECK (answer_hash ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL, UNIQUE(session_id,revision)
);
CREATE TABLE onboarding.extraction_proposals (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES onboarding.interview_sessions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('discovery','profile')), mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  answer_revision integer NOT NULL CHECK (answer_revision>=0), modes_version integer NOT NULL CHECK (modes_version>0), proposal_version integer NOT NULL DEFAULT 1 CHECK (proposal_version>0),
  state text NOT NULL CHECK (state IN ('pending','confirmed','expired','rejected','corrected')), expires_at timestamptz NOT NULL,
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1), provenance text NOT NULL CHECK (provenance IN ('member_text_extraction','local_rules','provider_model','member_correction')),
  payload_ciphertext text NOT NULL, payload_nonce text NOT NULL, payload_key_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL, confirmed_at timestamptz
);
CREATE INDEX onboarding_proposals_account_idx ON onboarding.extraction_proposals(account_id,created_at DESC);
CREATE TABLE onboarding.preference_sets (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('discovery','profile')), version integer NOT NULL CHECK (version>=0), current boolean NOT NULL,
  modes text[] NOT NULL CHECK (cardinality(modes)>0 AND modes <@ ARRAY['friends','activities','professional','circles','events','dating']), modes_version integer NOT NULL CHECK (modes_version>0), normalized_json jsonb NOT NULL,
  preferences_ciphertext text NOT NULL,
  preferences_nonce text NOT NULL, preferences_key_id text NOT NULL, confirmed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('manual','approved_ai_draft')),
  CHECK (jsonb_typeof(normalized_json)='array')
);
CREATE UNIQUE INDEX onboarding_current_preferences_unique ON onboarding.preference_sets(account_id,purpose) WHERE current;
CREATE TABLE onboarding.provider_consents (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE, purpose text NOT NULL CHECK (purpose IN ('discovery','profile')), provider text NOT NULL, receipt_version integer NOT NULL CHECK (receipt_version>0),
  retention text NOT NULL CHECK (retention IN ('none','session','thirty_days')), granted boolean NOT NULL,
  granted_at timestamptz NOT NULL, withdrawn_at timestamptz, UNIQUE(account_id,purpose,provider)
);
CREATE TABLE onboarding.consent_receipts (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('discovery','profile')), provider text NOT NULL, receipt_version integer NOT NULL CHECK (receipt_version>0), retention text NOT NULL CHECK (retention IN ('none','session','thirty_days')),
  granted boolean NOT NULL, recorded_at timestamptz NOT NULL
);
CREATE INDEX onboarding_consent_receipts_account_idx ON onboarding.consent_receipts(account_id,recorded_at DESC);
CREATE TABLE onboarding.corrections (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES onboarding.extraction_proposals(id), purpose text NOT NULL CHECK (purpose IN ('discovery','profile')), field text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version>=0), expected_proposal_version integer NOT NULL CHECK (expected_proposal_version>0),
  correction_ciphertext text NOT NULL, correction_nonce text NOT NULL, correction_key_id text NOT NULL,
  correction_hash text NOT NULL CHECK (correction_hash ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL
);
CREATE TABLE onboarding.idempotency_keys (
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE, key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'), result_ciphertext text NOT NULL, result_nonce text NOT NULL, result_key_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,key_digest)
);

CREATE OR REPLACE FUNCTION onboarding.validate_modes_array()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE distinct_count integer;
BEGIN
  IF NEW.modes IS NULL OR cardinality(NEW.modes) < 1 THEN
    RAISE EXCEPTION 'onboarding modes must not be empty';
  END IF;
  SELECT count(DISTINCT value) INTO distinct_count FROM unnest(NEW.modes) AS value;
  IF distinct_count <> cardinality(NEW.modes) THEN
    RAISE EXCEPTION 'onboarding modes must be unique';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER onboarding_interview_modes_shape
  BEFORE INSERT OR UPDATE OF modes ON onboarding.interview_sessions
  FOR EACH ROW EXECUTE FUNCTION onboarding.validate_modes_array();
CREATE TRIGGER onboarding_preference_modes_shape
  BEFORE INSERT OR UPDATE OF modes ON onboarding.preference_sets
  FOR EACH ROW EXECUTE FUNCTION onboarding.validate_modes_array();

CREATE OR REPLACE FUNCTION onboarding.validate_normalized_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; key_count integer;
BEGIN
  IF jsonb_typeof(NEW.normalized_json) <> 'array' THEN
    RAISE EXCEPTION 'onboarding normalized projection must be an array';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.normalized_json) LOOP
    IF jsonb_typeof(item) <> 'object' THEN
      RAISE EXCEPTION 'onboarding normalized projection contains a non-object item';
    END IF;
    SELECT count(*) INTO key_count FROM jsonb_object_keys(item);
    IF key_count <> 4
       OR NOT (item ?& ARRAY['mode','criterion','strength','deal_breaker'])
       OR item->>'mode' NOT IN ('friends','activities','professional','circles','events','dating')
       OR item->>'criterion' NOT IN ('communication_style','communication_frequency','shared_interests','geography','availability','values','lifestyle','language','distance')
       OR item->>'strength' NOT IN ('hard_requirement','strong_preference','weak_preference','does_not_matter')
       OR jsonb_typeof(item->'deal_breaker') <> 'boolean'
       OR (item->>'strength' = 'does_not_matter' AND (item->>'deal_breaker')::boolean) THEN
      RAISE EXCEPTION 'onboarding normalized projection contains an invalid or non-minimal item';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER onboarding_preference_projection_shape
  BEFORE INSERT OR UPDATE OF normalized_json ON onboarding.preference_sets
  FOR EACH ROW EXECUTE FUNCTION onboarding.validate_normalized_projection();

CREATE OR REPLACE FUNCTION onboarding.validate_answer_session_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_purpose text; session_modes text[];
BEGIN
  SELECT purpose,modes INTO session_purpose,session_modes
    FROM onboarding.interview_sessions WHERE id=NEW.session_id;
  IF session_purpose IS NULL OR NEW.purpose <> session_purpose
     OR NOT (NEW.mode = ANY(session_modes)) THEN
    RAISE EXCEPTION 'onboarding row is outside its session purpose/mode/version';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION onboarding.validate_proposal_session_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_purpose text; session_modes text[]; session_modes_version integer;
BEGIN
  SELECT purpose,modes,modes_version INTO session_purpose,session_modes,session_modes_version
    FROM onboarding.interview_sessions WHERE id=NEW.session_id;
  IF session_purpose IS NULL OR NEW.purpose <> session_purpose
     OR NOT (NEW.mode = ANY(session_modes))
     OR NEW.modes_version <> session_modes_version THEN
    RAISE EXCEPTION 'onboarding row is outside its session purpose/mode/version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER onboarding_answer_session_scope
  BEFORE INSERT OR UPDATE ON onboarding.answer_revisions
  FOR EACH ROW EXECUTE FUNCTION onboarding.validate_answer_session_scope();
CREATE TRIGGER onboarding_proposal_session_scope
  BEFORE INSERT OR UPDATE ON onboarding.extraction_proposals
  FOR EACH ROW EXECUTE FUNCTION onboarding.validate_proposal_session_scope();

CREATE OR REPLACE FUNCTION onboarding.idempotency_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The only permitted DELETE is the FK cascade initiated by deleting the
  -- parent IAM account. PostgreSQL removes the parent from the statement's
  -- visible row set before invoking the child cascade trigger. Direct and
  -- nested deletes still see the parent and remain immutable.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM iam.accounts WHERE id=OLD.account_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'onboarding idempotency rows are immutable';
END $$;
CREATE TRIGGER onboarding_idempotency_append_only
  BEFORE UPDATE OR DELETE ON onboarding.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION onboarding.idempotency_append_only();
-- +END UP
-- +BEGIN DOWN
DROP SCHEMA IF EXISTS onboarding CASCADE;
-- +END DOWN
