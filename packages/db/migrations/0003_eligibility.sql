-- ELG-01: eligibility schema — jurisdiction declarations/policies, encrypted
-- age evidence, immutable age credentials, append-only decision snapshots.
-- The DDL source of truth is this file; packages/db/src/eligibility/schema.ts
-- only mirrors it for compile-time types (drift is caught by migration tests).
--
-- Privacy invariants: the exact birthday exists ONLY as AES-256-GCM
-- ciphertext + nonce/tag + key id (age_evidence); no plaintext birthday
-- column exists anywhere in the schema. Mode/partition decisions store only
-- derived, non-PII facts (age band, per-year cohort, assurance level).

-- +BEGIN UP
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA eligibility;

-- ---------------------------------------------------------------------------
-- jurisdiction_declarations: one current declaration per account; history is
-- append-only (supersede, never overwrite).
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility.jurisdiction_declarations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  subdivision_code text CHECK (subdivision_code IS NULL OR subdivision_code ~ '^[A-Z0-9]{1,3}$'),
  source text NOT NULL CHECK (source IN ('self_declared', 'reviewed')),
  review_state text NOT NULL CHECK (review_state IN ('accepted', 'conflict_review_required')),
  effective_from timestamptz NOT NULL,
  superseded_at timestamptz,
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  CONSTRAINT jurisdiction_declarations_version_unique UNIQUE (account_id, version)
);

-- Exactly one current declaration per account.
CREATE UNIQUE INDEX jurisdiction_declarations_current_unique
  ON eligibility.jurisdiction_declarations (account_id)
  WHERE superseded_at IS NULL;

CREATE INDEX jurisdiction_declarations_account_created_idx
  ON eligibility.jurisdiction_declarations (account_id, created_at DESC);

-- History is append-only: an UPDATE may only mark the current row superseded.
CREATE FUNCTION eligibility.jurisdiction_declaration_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Direct deletes fire at depth 1; cascade deletes (account erasure)
    -- at depth >= 2 and must pass.
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'jurisdiction declarations are never deleted directly';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'superseded jurisdiction declaration is immutable';
  END IF;
  IF NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'current jurisdiction declaration cannot be modified in place';
  END IF;
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
     OR NEW.country_code <> OLD.country_code OR NEW.subdivision_code IS DISTINCT FROM OLD.subdivision_code
     OR NEW.source <> OLD.source OR NEW.review_state <> OLD.review_state
     OR NEW.effective_from <> OLD.effective_from OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'superseding a declaration may only set superseded_at';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER jurisdiction_declarations_guard
  BEFORE UPDATE OR DELETE ON eligibility.jurisdiction_declarations
  FOR EACH ROW EXECUTE FUNCTION eligibility.jurisdiction_declaration_guard();

-- ---------------------------------------------------------------------------
-- jurisdiction_policies: immutable approved content, non-overlapping
-- effective intervals per jurisdiction, hashed content.
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility.jurisdiction_policies (
  id uuid PRIMARY KEY,
  jurisdiction_key text NOT NULL CHECK (jurisdiction_key ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  revision integer NOT NULL CHECK (revision >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'retired')),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  rule_hash text NOT NULL CHECK (rule_hash ~ '^[0-9a-f]{64}$'),
  timezone text NOT NULL CHECK (timezone <> ''),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NOT NULL DEFAULT 'infinity',
  is_synthetic boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT jurisdiction_policies_revision_unique UNIQUE (jurisdiction_key, revision),
  CONSTRAINT jurisdiction_policies_interval_chk CHECK (effective_from < effective_until)
);

-- Approved policies for one jurisdiction must never overlap in effect.
ALTER TABLE eligibility.jurisdiction_policies
  ADD CONSTRAINT jurisdiction_policies_no_overlap
  EXCLUDE USING gist (
    jurisdiction_key WITH =,
    tstzrange(effective_from, effective_until, '[)') WITH &&
  ) WHERE (status = 'approved');

-- Approved content is immutable; only the approved -> retired transition
-- (setting retired_at) may touch the row, and direct deletes are blocked
-- (audit history; no cascade path reaches policies).
CREATE FUNCTION eligibility.jurisdiction_policy_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jurisdiction policy rows are never deleted';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'retired' THEN
    IF NEW.content_hash <> OLD.content_hash OR NEW.rule_hash <> OLD.rule_hash
       OR NEW.revision <> OLD.revision OR NEW.jurisdiction_key <> OLD.jurisdiction_key
       OR NEW.timezone <> OLD.timezone OR NEW.effective_from <> OLD.effective_from
       OR NEW.effective_until <> OLD.effective_until OR NEW.is_synthetic <> OLD.is_synthetic THEN
      RAISE EXCEPTION 'approved policy is immutable except status/retired_at';
    END IF;
    NEW.retired_at = COALESCE(NEW.retired_at, now());
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'approved policy cannot be modified in place';
  END IF;
  IF NEW.status = 'approved' THEN
    NEW.retired_at = NULL;
    RETURN NEW;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired policy is terminal';
  END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'invalid policy status transition';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER jurisdiction_policies_guard
  BEFORE UPDATE OR DELETE ON eligibility.jurisdiction_policies
  FOR EACH ROW EXECUTE FUNCTION eligibility.jurisdiction_policy_guard();

-- ---------------------------------------------------------------------------
-- age_evidence: encrypted birthday evidence. One current row per account;
-- superseded rows keep the audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility.age_evidence (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
  -- Keyed HMAC of the birthday (context 'birthday', same construction as
  -- iam.accounts.email_digest). Makes re-declaration idempotent WITHOUT
  -- decrypting or storing any plaintext birthday: the ciphertext is
  -- randomized per write, so only a keyed digest can identify "same date".
  birthday_digest text NOT NULL CHECK (birthday_digest ~ '^[0-9a-f]{64}$'),
  birthday_ciphertext text NOT NULL CHECK (birthday_ciphertext <> ''),
  birthday_nonce text NOT NULL CHECK (birthday_nonce <> ''),
  birthday_key_id text NOT NULL CHECK (birthday_key_id <> ''),
  source text NOT NULL CHECK (source = 'self_declared'),
  declared_at timestamptz NOT NULL,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX age_evidence_current_unique
  ON eligibility.age_evidence (account_id)
  WHERE superseded_at IS NULL;

-- Evidence rows are never edited; the current row may only be superseded.
CREATE FUNCTION eligibility.age_evidence_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'superseded age evidence is immutable';
    END IF;
    IF NEW.superseded_at IS NULL OR NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
       OR NEW.birthday_digest <> OLD.birthday_digest
       OR NEW.birthday_ciphertext <> OLD.birthday_ciphertext OR NEW.birthday_nonce <> OLD.birthday_nonce
       OR NEW.birthday_key_id <> OLD.birthday_key_id OR NEW.source <> OLD.source
       OR NEW.declared_at <> OLD.declared_at THEN
      RAISE EXCEPTION 'age evidence may only be marked superseded';
    END IF;
    RETURN NEW;
  END IF;
  -- Direct deletes fire at depth 1 and are blocked (append-only history);
  -- cascade deletes (account erasure) fire at depth >= 2 and must pass.
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'age evidence is append-only (cascade erasure only)';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER age_evidence_guard
  BEFORE UPDATE OR DELETE ON eligibility.age_evidence
  FOR EACH ROW EXECUTE FUNCTION eligibility.age_evidence_guard();

-- ---------------------------------------------------------------------------
-- age_credentials: immutable snapshots (band/cohort/assurance at issue time).
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility.age_credentials (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
  age_band text NOT NULL CHECK (age_band IN ('unknown', 'below_minimum', 'youth', 'adult')),
  cohort_key text NOT NULL CHECK (cohort_key ~ '^(below_minimum|adult|youth_[0-9]{1,3})$'),
  assurance_level text NOT NULL CHECK (assurance_level IN ('self_declared', 'externally_attested')),
  issuer_type text NOT NULL CHECK (issuer_type IN ('eligibility_self_declaration', 'verification_module')),
  source_evidence_id uuid NOT NULL REFERENCES eligibility.age_evidence (id),
  jurisdiction_policy_id uuid NOT NULL REFERENCES eligibility.jurisdiction_policies (id),
  policy_revision integer NOT NULL CHECK (policy_revision >= 1),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  superseded_at timestamptz,
  derived_at timestamptz NOT NULL,
  derivation_version integer NOT NULL CHECK (derivation_version >= 1),
  created_at timestamptz NOT NULL,
  CONSTRAINT age_credentials_interval_chk CHECK (valid_from < valid_until)
);

CREATE UNIQUE INDEX age_credentials_current_unique
  ON eligibility.age_credentials (account_id)
  WHERE superseded_at IS NULL;

CREATE INDEX age_credentials_account_created_idx
  ON eligibility.age_credentials (account_id, created_at DESC);

CREATE FUNCTION eligibility.age_credentials_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Issued content is immutable; the only legal UPDATE marks the current
    -- credential superseded (nothing else may change).
    IF OLD.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'superseded age credentials are immutable';
    END IF;
    IF NEW.superseded_at IS NULL OR NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
       OR NEW.age_band <> OLD.age_band OR NEW.cohort_key <> OLD.cohort_key
       OR NEW.assurance_level <> OLD.assurance_level OR NEW.issuer_type <> OLD.issuer_type
       OR NEW.source_evidence_id <> OLD.source_evidence_id
       OR NEW.jurisdiction_policy_id <> OLD.jurisdiction_policy_id
       OR NEW.policy_revision <> OLD.policy_revision OR NEW.valid_from <> OLD.valid_from
       OR NEW.valid_until <> OLD.valid_until OR NEW.derived_at <> OLD.derived_at
       OR NEW.derivation_version <> OLD.derivation_version THEN
      RAISE EXCEPTION 'age credentials may only be marked superseded';
    END IF;
    RETURN NEW;
  END IF;
  -- Direct deletes fire at depth 1 and are blocked; cascade deletes
  -- (account erasure) fire at depth >= 2 and must pass.
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'age credentials are immutable';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER age_credentials_guard
  BEFORE UPDATE OR DELETE ON eligibility.age_credentials
  FOR EACH ROW EXECUTE FUNCTION eligibility.age_credentials_guard();

-- ---------------------------------------------------------------------------
-- mode_decisions: append-only single-subject snapshots; decision_id is the
-- deterministic idempotency key.
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility.mode_decisions (
  decision_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope = 'age_and_jurisdiction'),
  mode text NOT NULL CHECK (mode IN ('friends', 'activities', 'professional', 'circles', 'events', 'dating')),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  age_band text NOT NULL CHECK (age_band IN ('unknown', 'below_minimum', 'youth', 'adult')),
  cohort_key text NOT NULL CHECK (cohort_key ~ '^(below_minimum|adult|youth_[0-9]{1,3})$'),
  assurance_level text NOT NULL CHECK (assurance_level IN ('self_declared', 'externally_attested')),
  reason_codes text[] NOT NULL CHECK (
    reason_codes <@ ARRAY[
      'ELIGIBILITY_INCOMPLETE', 'NO_ACTIVE_JURISDICTION_POLICY',
      'JURISDICTION_REVIEW_REQUIRED', 'BELOW_MINIMUM_ACCOUNT_AGE',
      'PARENTAL_CONSENT_REQUIRED', 'YOUTH_NOT_LAUNCHED', 'MODE_DISABLED',
      'MODE_MINIMUM_AGE_NOT_MET', 'ADULT_THRESHOLD_NOT_MET',
      'AGE_ASSURANCE_REQUIRED', 'CROSS_COHORT_DENIED',
      'POLICY_ENGINE_UNAVAILABLE', 'POLICY_OUTPUT_INVALID',
      'ACCOUNT_NOT_ENABLED'
    ]::text[]
  ),
  obligations text[] NOT NULL DEFAULT '{}' CHECK (
    obligations <@ ARRAY['parental_consent_required']::text[]
  ),
  policy_id uuid NOT NULL REFERENCES eligibility.jurisdiction_policies (id),
  policy_revision integer NOT NULL CHECK (policy_revision >= 1),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  credential_id uuid NOT NULL REFERENCES eligibility.age_credentials (id),
  credential_hash text NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  evaluated_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  engine_version integer NOT NULL CHECK (engine_version >= 1),
  created_at timestamptz NOT NULL,
  CONSTRAINT mode_decisions_reason_invariant_chk CHECK (
    (decision = 'allow' AND cardinality(reason_codes) = 0)
    OR (decision = 'deny' AND cardinality(reason_codes) > 0)
  )
);

CREATE INDEX mode_decisions_account_evaluated_idx
  ON eligibility.mode_decisions (account_id, evaluated_at DESC);

CREATE FUNCTION eligibility.append_only_guard() RETURNS trigger AS $$
BEGIN
  -- A top-level statement fires its row triggers at depth 1; FK cascades
  -- (account erasure DELETEs, the policy_events ON DELETE SET NULL UPDATE)
  -- fire at depth >= 2 and must pass. RETURN NEW so the cascade's change
  -- (SET NULL) is preserved — RETURN OLD would revert it.
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER mode_decisions_guard
  BEFORE UPDATE OR DELETE ON eligibility.mode_decisions
  FOR EACH ROW EXECUTE FUNCTION eligibility.append_only_guard();

-- ---------------------------------------------------------------------------
-- partition_decisions: append-only two-party snapshots. Stores only derived
-- cohort facts and stable capability/reason codes — never a displayable
-- profile of either party.
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility.partition_decisions (
  decision_id uuid PRIMARY KEY,
  actor_account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
  subject_account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
  actor_age_band text NOT NULL CHECK (actor_age_band IN ('unknown', 'below_minimum', 'youth', 'adult')),
  actor_cohort_key text NOT NULL CHECK (actor_cohort_key ~ '^(below_minimum|adult|youth_[0-9]{1,3})$'),
  subject_age_band text NOT NULL CHECK (subject_age_band IN ('unknown', 'below_minimum', 'youth', 'adult')),
  subject_cohort_key text NOT NULL CHECK (subject_cohort_key ~ '^(below_minimum|adult|youth_[0-9]{1,3})$'),
  capability text NOT NULL CHECK (capability IN ('discover', 'introduce', 'direct_message', 'event_visibility', 'dating')),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_codes text[] NOT NULL CHECK (
    reason_codes <@ ARRAY[
      'ELIGIBILITY_INCOMPLETE', 'NO_ACTIVE_JURISDICTION_POLICY',
      'JURISDICTION_REVIEW_REQUIRED', 'BELOW_MINIMUM_ACCOUNT_AGE',
      'PARENTAL_CONSENT_REQUIRED', 'YOUTH_NOT_LAUNCHED', 'MODE_DISABLED',
      'MODE_MINIMUM_AGE_NOT_MET', 'ADULT_THRESHOLD_NOT_MET',
      'AGE_ASSURANCE_REQUIRED', 'CROSS_COHORT_DENIED',
      'POLICY_ENGINE_UNAVAILABLE', 'POLICY_OUTPUT_INVALID',
      'ACCOUNT_NOT_ENABLED'
    ]::text[]
  ),
  actor_policy_id uuid NOT NULL REFERENCES eligibility.jurisdiction_policies (id),
  subject_policy_id uuid NOT NULL REFERENCES eligibility.jurisdiction_policies (id),
  actor_policy_revision integer NOT NULL CHECK (actor_policy_revision >= 1),
  subject_policy_revision integer NOT NULL CHECK (subject_policy_revision >= 1),
  actor_policy_hash text NOT NULL CHECK (actor_policy_hash ~ '^[0-9a-f]{64}$'),
  subject_policy_hash text NOT NULL CHECK (subject_policy_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  evaluated_at timestamptz NOT NULL,
  engine_version integer NOT NULL CHECK (engine_version >= 1),
  created_at timestamptz NOT NULL,
  CONSTRAINT partition_decisions_reason_invariant_chk CHECK (
    (decision = 'allow' AND cardinality(reason_codes) = 0)
    OR (decision = 'deny' AND cardinality(reason_codes) > 0)
  )
);

CREATE INDEX partition_decisions_actor_evaluated_idx
  ON eligibility.partition_decisions (actor_account_id, evaluated_at DESC);

CREATE TRIGGER partition_decisions_guard
  BEFORE UPDATE OR DELETE ON eligibility.partition_decisions
  FOR EACH ROW EXECUTE FUNCTION eligibility.append_only_guard();

-- ---------------------------------------------------------------------------
-- policy_events: append-only operational/audit events. account_id is only
-- optional correlation context and is nulled (not deleted) on erasure.
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility.policy_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN (
    'policy_published', 'policy_retired', 'declaration_conflict',
    'credential_issued', 'credential_superseded', 'evaluation_failure',
    'policy_validation_failure'
  )),
  policy_id uuid REFERENCES eligibility.jurisdiction_policies (id),
  jurisdiction_key text CHECK (jurisdiction_key IS NULL OR jurisdiction_key ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  account_id uuid REFERENCES iam.accounts (id) ON DELETE SET NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE INDEX policy_events_created_idx ON eligibility.policy_events (created_at DESC);

CREATE TRIGGER policy_events_guard
  BEFORE UPDATE OR DELETE ON eligibility.policy_events
  FOR EACH ROW EXECUTE FUNCTION eligibility.append_only_guard();
-- +END UP

-- +BEGIN DOWN
-- btree_gist is a shared per-database extension (0003 is the only user and
-- nothing else in the repo depends on it); dropping extensions during
-- rollback risks breaking concurrent objects, so it is intentionally left
-- installed.
DROP SCHEMA eligibility CASCADE;
-- +END DOWN
