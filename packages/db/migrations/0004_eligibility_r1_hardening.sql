-- ELG-01-R1 hardening.  Keep 0003 immutable; this forward migration adds
-- governance evidence, durable idempotency and a governed policy publish path.
-- +BEGIN UP
ALTER TABLE eligibility.jurisdiction_policies
  ADD COLUMN location_precision_policy text NOT NULL DEFAULT 'country_and_subdivision'
    CHECK (location_precision_policy IN ('country_only', 'country_and_subdivision')),
  ADD COLUMN profiling_policy text NOT NULL DEFAULT 'derived_facts_only'
    CHECK (profiling_policy IN ('derived_facts_only', 'prohibited')),
  ADD COLUMN retention_policy text NOT NULL DEFAULT 'credential_until_superseded'
    CHECK (retention_policy <> ''),
  ADD COLUMN legal_basis_refs text[] NOT NULL DEFAULT ARRAY['legacy:elg-01']::text[]
    CHECK (cardinality(legal_basis_refs) > 0),
  ADD COLUMN reviewed_by text NOT NULL DEFAULT 'legacy-migration'
    CHECK (reviewed_by <> ''),
  ADD COLUMN reviewed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE eligibility.jurisdiction_policies
  ALTER COLUMN location_precision_policy DROP DEFAULT,
  ALTER COLUMN profiling_policy DROP DEFAULT,
  ALTER COLUMN retention_policy DROP DEFAULT,
  ALTER COLUMN legal_basis_refs DROP DEFAULT,
  ALTER COLUMN reviewed_by DROP DEFAULT,
  ALTER COLUMN reviewed_at DROP DEFAULT;

CREATE OR REPLACE FUNCTION eligibility.jurisdiction_policy_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved'
       AND COALESCE(current_setting('app.eligibility_policy_publish', true), '') <> 'true' THEN
      RAISE EXCEPTION 'approved policies must use the governed publication path';
    END IF;
    NEW.retired_at = NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jurisdiction policy rows are never deleted';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'retired' THEN
    IF NEW.content_hash <> OLD.content_hash OR NEW.rule_hash <> OLD.rule_hash
       OR NEW.revision <> OLD.revision OR NEW.jurisdiction_key <> OLD.jurisdiction_key
       OR NEW.timezone <> OLD.timezone OR NEW.effective_from <> OLD.effective_from
       OR NEW.effective_until <> OLD.effective_until OR NEW.is_synthetic <> OLD.is_synthetic
       OR NEW.location_precision_policy <> OLD.location_precision_policy
       OR NEW.profiling_policy <> OLD.profiling_policy
       OR NEW.retention_policy <> OLD.retention_policy
       OR NEW.legal_basis_refs <> OLD.legal_basis_refs
       OR NEW.reviewed_by <> OLD.reviewed_by OR NEW.reviewed_at <> OLD.reviewed_at THEN
      RAISE EXCEPTION 'approved policy is immutable except status/retired_at';
    END IF;
    NEW.retired_at = COALESCE(NEW.retired_at, now());
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'approved policy cannot be modified in place';
  END IF;
  IF NEW.status = 'approved' THEN
    IF COALESCE(current_setting('app.eligibility_policy_publish', true), '') <> 'true' THEN
      RAISE EXCEPTION 'approved policies must use the governed publication path';
    END IF;
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

DROP TRIGGER jurisdiction_policies_guard ON eligibility.jurisdiction_policies;
CREATE TRIGGER jurisdiction_policies_guard
  BEFORE INSERT OR UPDATE OR DELETE ON eligibility.jurisdiction_policies
  FOR EACH ROW EXECUTE FUNCTION eligibility.jurisdiction_policy_guard();

ALTER TABLE eligibility.mode_decisions ADD COLUMN idempotency_key text;
ALTER TABLE eligibility.mode_decisions
  ADD COLUMN effective_at_defaulted boolean NOT NULL DEFAULT false;
ALTER TABLE eligibility.age_credentials ADD COLUMN jurisdiction_key text;
CREATE UNIQUE INDEX mode_decisions_defaulted_idempotency_unique
  ON eligibility.mode_decisions (account_id, idempotency_key, mode)
  WHERE idempotency_key IS NOT NULL AND effective_at_defaulted;
-- +END UP

-- +BEGIN DOWN
DROP INDEX IF EXISTS eligibility.mode_decisions_defaulted_idempotency_unique;
ALTER TABLE eligibility.mode_decisions DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE eligibility.mode_decisions DROP COLUMN IF EXISTS effective_at_defaulted;
ALTER TABLE eligibility.age_credentials DROP COLUMN IF EXISTS jurisdiction_key;
-- The 0003 trigger function remains installed; dropping its function would
-- invalidate the trigger. A subsequent full rollback removes the schema.
ALTER TABLE eligibility.jurisdiction_policies
  DROP COLUMN IF EXISTS location_precision_policy,
  DROP COLUMN IF EXISTS profiling_policy,
  DROP COLUMN IF EXISTS retention_policy,
  DROP COLUMN IF EXISTS legal_basis_refs,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS reviewed_at;
CREATE OR REPLACE FUNCTION eligibility.jurisdiction_policy_guard() RETURNS trigger AS $$
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
DROP TRIGGER jurisdiction_policies_guard ON eligibility.jurisdiction_policies;
CREATE TRIGGER jurisdiction_policies_guard
  BEFORE UPDATE OR DELETE ON eligibility.jurisdiction_policies
  FOR EACH ROW EXECUTE FUNCTION eligibility.jurisdiction_policy_guard();
-- +END DOWN
