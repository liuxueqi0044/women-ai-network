-- VER-01 identity, external age assurance and membership evidence.
-- Raw provider payloads, DOB and provider references are intentionally absent.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS verification;

ALTER TABLE eligibility.age_evidence
  ADD COLUMN IF NOT EXISTS verification_case_id uuid,
  ADD COLUMN IF NOT EXISTS external_attestation_digest text;
ALTER TABLE eligibility.age_evidence
  DROP CONSTRAINT IF EXISTS age_evidence_source_check;
ALTER TABLE eligibility.age_evidence
  ADD CONSTRAINT age_evidence_source_check CHECK (source IN ('self_declared', 'verification_provider'));

CREATE TABLE verification.identity_cases (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('not_started','session_created','pending','processing','verified','retryable','requires_input','needs_review','failed','expired','canceled')),
  age_assurance_state text NOT NULL CHECK (age_assurance_state IN ('unverified','pending','attested','mismatch','insufficient','needs_review','revoked')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  verified_at timestamptz,
  last_provider_occurred_at timestamptz,
  last_provider_event_id text
);
CREATE UNIQUE INDEX identity_cases_active_account_unique ON verification.identity_cases(account_id) WHERE state NOT IN ('failed','expired','canceled');

ALTER TABLE eligibility.age_evidence
  ADD CONSTRAINT age_evidence_verification_case_fk
    FOREIGN KEY (verification_case_id) REFERENCES verification.identity_cases(id),
  ADD CONSTRAINT age_evidence_verification_source_check CHECK (
    (source = 'self_declared' AND verification_case_id IS NULL AND external_attestation_digest IS NULL)
    OR
    (source = 'verification_provider' AND verification_case_id IS NOT NULL
      AND external_attestation_digest ~ '^[0-9a-f]{64}$')
  );

CREATE TABLE verification.verification_attempts (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES verification.identity_cases(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider <> ''),
  session_ref_ciphertext text NOT NULL,
  session_ref_nonce text NOT NULL,
  session_ref_key_id text NOT NULL,
  session_ref_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('created','pending','processing','verified','requires_input','failed','expired','canceled','redacted')),
  idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(case_id, idempotency_key), UNIQUE(provider, session_ref_digest)
);

CREATE TABLE verification.provider_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  payload_digest text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('claimed','processing','processed','retryable','conflict','ignored')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_safe text,
  next_retry_at timestamptz,
  lease_until timestamptz,
  processing_token uuid,
  processed_at timestamptz,
  UNIQUE(provider, provider_event_id)
);

CREATE TABLE verification.identity_bindings (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  subject_digest text NOT NULL,
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('active','needs_review','redacted')),
  created_at timestamptz NOT NULL,
  UNIQUE(provider, subject_digest)
);

CREATE TABLE verification.membership_policies (
  id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft','approved','retired')),
  content_hash text NOT NULL,
  legal_basis_ref text NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NOT NULL DEFAULT 'infinity',
  created_at timestamptz NOT NULL,
  PRIMARY KEY(id, revision), UNIQUE(content_hash),
  CONSTRAINT membership_policies_interval_check CHECK (effective_from < effective_until),
  CONSTRAINT membership_policies_review_check CHECK (
    status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX membership_policies_approved_unique ON verification.membership_policies(id) WHERE status = 'approved';

CREATE FUNCTION verification.membership_policy_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status IN ('approved','retired') THEN
    RAISE EXCEPTION 'approved membership policy history cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' THEN
    IF NEW.status = 'retired'
       AND NEW.id = OLD.id AND NEW.revision = OLD.revision
       AND NEW.content_hash = OLD.content_hash AND NEW.legal_basis_ref = OLD.legal_basis_ref
       AND NEW.reviewed_by = OLD.reviewed_by AND NEW.reviewed_at = OLD.reviewed_at
       AND NEW.effective_from = OLD.effective_from AND NEW.effective_until = OLD.effective_until THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'approved membership policy is immutable except retirement';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired membership policy is terminal';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER membership_policies_guard
  BEFORE UPDATE OR DELETE ON verification.membership_policies
  FOR EACH ROW EXECUTE FUNCTION verification.membership_policy_guard();

CREATE TABLE verification.membership_cases (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL,
  policy_revision integer NOT NULL,
  policy_content_hash text NOT NULL,
  statement_category text NOT NULL CHECK (statement_category IN ('community_participation','safety_commitment')),
  consented_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('not_applied','submitted','under_review','approved','rejected','withdrawn')),
  version integer NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT membership_cases_policy_revision_fk FOREIGN KEY (policy_id, policy_revision)
    REFERENCES verification.membership_policies(id, revision)
);
CREATE UNIQUE INDEX membership_cases_current_unique ON verification.membership_cases(account_id) WHERE state NOT IN ('withdrawn');

CREATE TABLE verification.membership_reviews (
  id uuid PRIMARY KEY,
  membership_case_id uuid NOT NULL REFERENCES verification.membership_cases(id) ON DELETE CASCADE,
  reviewer_principal text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason_code text NOT NULL CHECK (reason_code IN ('POLICY_REQUIREMENTS_MET','INSUFFICIENT_EVIDENCE','POLICY_MISMATCH','SAFETY_REVIEW_REQUIRED')),
  created_at timestamptz NOT NULL
);

CREATE TABLE verification.membership_appeals (
  id uuid PRIMARY KEY,
  membership_case_id uuid NOT NULL REFERENCES verification.membership_cases(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('incorrect_decision','new_information','accessibility')),
  statement_ciphertext text NOT NULL,
  statement_nonce text NOT NULL,
  statement_key_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('submitted','under_review','upheld','overturned')),
  reviewer_principal text,
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('NEW_INFORMATION_ACCEPTED','APPEAL_UPHELD','POLICY_MISMATCH','SAFETY_REVIEW_REQUIRED')),
  created_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE UNIQUE INDEX membership_appeals_open_unique ON verification.membership_appeals(membership_case_id) WHERE state IN ('submitted','under_review');

CREATE TABLE verification.redaction_requests (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('requested','under_review','completed','held')),
  legal_hold boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE UNIQUE INDEX redaction_requests_open_unique ON verification.redaction_requests(account_id)
  WHERE state IN ('requested','under_review','held');

CREATE TABLE verification.audit_events (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  case_id uuid,
  event_type text NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL
);
CREATE INDEX verification_audit_account_idx ON verification.audit_events(account_id, created_at);

-- +END UP

-- +BEGIN DOWN
ALTER TABLE eligibility.age_evidence
  DROP CONSTRAINT IF EXISTS age_evidence_verification_case_fk,
  DROP CONSTRAINT IF EXISTS age_evidence_verification_source_check;
DROP TABLE IF EXISTS verification.audit_events;
DROP TABLE IF EXISTS verification.redaction_requests;
DROP TABLE IF EXISTS verification.membership_appeals;
DROP TABLE IF EXISTS verification.membership_reviews;
DROP TABLE IF EXISTS verification.membership_cases;
DROP TABLE IF EXISTS verification.membership_policies;
DROP TABLE IF EXISTS verification.identity_bindings;
DROP TABLE IF EXISTS verification.provider_events;
DROP TABLE IF EXISTS verification.verification_attempts;
DROP TABLE IF EXISTS verification.identity_cases;
DROP FUNCTION IF EXISTS verification.membership_policy_guard();
DROP SCHEMA IF EXISTS verification;
ALTER TABLE eligibility.age_evidence DROP COLUMN IF EXISTS verification_case_id;
ALTER TABLE eligibility.age_evidence DROP COLUMN IF EXISTS external_attestation_digest;
ALTER TABLE eligibility.age_evidence DROP CONSTRAINT IF EXISTS age_evidence_source_check;
ALTER TABLE eligibility.age_evidence ADD CONSTRAINT age_evidence_source_check CHECK (source IN ('self_declared'));
-- +END DOWN
