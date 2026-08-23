-- SAF-01 global safety control plane. Evidence is encrypted before it reaches
-- this schema; no source body, media bytes or moderator notes are persisted.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS safety;

CREATE TABLE safety.blocks (
  id uuid PRIMARY KEY,
  blocker_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  blocked_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('harassment','unwanted_contact','safety_concern','privacy','other')),
  idempotency_digest text NOT NULL,
  request_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','revoked')),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (blocker_account_id IS NULL OR blocked_account_id IS NULL OR blocker_account_id <> blocked_account_id),
  CHECK ((state = 'active' AND revoked_at IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX safety_blocks_active_unique ON safety.blocks(blocker_account_id, blocked_account_id) WHERE state = 'active';
CREATE UNIQUE INDEX safety_blocks_idempotency_unique ON safety.blocks(blocker_account_id, idempotency_digest);
CREATE INDEX safety_blocks_subject_active_idx ON safety.blocks(blocked_account_id, state);

CREATE TABLE safety.reports (
  id uuid PRIMARY KEY,
  reporter_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  subject_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('account','profile','message','media','event')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 256),
  category text NOT NULL CHECK (category IN ('harassment','threats','sexual_content','hate_or_discrimination','scam_or_fraud','privacy_violation','other')),
  idempotency_digest text NOT NULL,
  request_digest text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','triaged','investigating','action_pending','resolved','dismissed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (reporter_account_id IS NULL OR subject_account_id IS NULL OR reporter_account_id <> subject_account_id)
);
CREATE UNIQUE INDEX safety_reports_idempotency_unique ON safety.reports(reporter_account_id, idempotency_digest);
CREATE INDEX safety_reports_subject_idx ON safety.reports(subject_account_id, created_at);

CREATE TABLE safety.evidence_snapshots (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES safety.reports(id),
  encrypted_snapshot text NOT NULL,
  snapshot_nonce text NOT NULL,
  key_id text NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  source_version text,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX safety_evidence_report_unique ON safety.evidence_snapshots(report_id);

CREATE TABLE safety.cases (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES safety.reports(id),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  queue text NOT NULL CHECK (queue <> ''),
  state text NOT NULL CHECK (state IN ('open','triaged','investigating','action_pending','resolved','dismissed')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  sla_due_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX safety_cases_report_unique ON safety.cases(report_id);
CREATE INDEX safety_cases_queue_lease_idx ON safety.cases(queue, state, lease_until);

CREATE TABLE safety.case_access_audit (
  id bigserial PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES safety.cases(id),
  actor_id text NOT NULL,
  purpose text NOT NULL,
  fields_class text NOT NULL CHECK (fields_class IN ('metadata','vault','action','appeal')),
  decision text NOT NULL CHECK (decision IN ('allow','deny')),
  created_at timestamptz NOT NULL
);

CREATE TABLE safety.actions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES safety.cases(id),
  action_type text NOT NULL CHECK (action_type IN ('temporary_restriction','permanent_ban','youth_restriction','evidence_export')),
  state text NOT NULL CHECK (state IN ('proposed','approved','executing','executed','rejected','failed')),
  proposer_id text NOT NULL,
  approver_id text,
  reason_code text NOT NULL,
  effective_from timestamptz,
  effective_until timestamptz,
  execution_token uuid,
  executed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (state NOT IN ('approved','executing','executed') OR action_type NOT IN ('permanent_ban','youth_restriction','evidence_export') OR (approver_id IS NOT NULL AND approver_id <> proposer_id)),
  CHECK (reason_code IN ('POLICY_VIOLATION_CONFIRMED','IMMINENT_SAFETY_RISK','REPEAT_HARASSMENT','YOUTH_SAFETY_ESCALATION','EVIDENCE_DISCLOSURE_REQUIRED')),
  CHECK (state NOT IN ('approved','executing','executed') OR approver_id IS NOT NULL),
  CHECK (state <> 'executed' OR (executed_at IS NOT NULL AND execution_token IS NOT NULL)),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_from < effective_until)
);
CREATE INDEX safety_actions_case_idx ON safety.actions(case_id, created_at);

CREATE TABLE safety.appeals (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES safety.actions(id),
  appellant_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('incorrect_decision','new_information','accessibility')),
  statement_ciphertext text NOT NULL,
  statement_nonce text NOT NULL,
  statement_key_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('submitted','under_review','upheld','overturned')),
  reviewer_id text,
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('APPEAL_UPHELD','NEW_INFORMATION_ACCEPTED','POLICY_MISMATCH','SAFETY_REVIEW_REQUIRED')),
  created_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE UNIQUE INDEX safety_appeals_open_unique ON safety.appeals(action_id) WHERE state IN ('submitted','under_review');

-- Legal holds are append-only facts, separate from the immutable snapshot row.
CREATE TABLE safety.evidence_holds (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES safety.evidence_snapshots(id),
  actor_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('LEGAL_REQUEST','ACTIVE_CASE','RETENTION_EXCEPTION')),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX safety_evidence_holds_snapshot_unique ON safety.evidence_holds(snapshot_id);

CREATE TABLE safety.audit_events (
  id bigserial PRIMARY KEY,
  actor_id text,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata_json text NOT NULL CHECK (metadata_json NOT LIKE '%statement%' AND metadata_json NOT LIKE '%evidence%'),
  previous_hash text,
  event_hash text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL
);
CREATE INDEX safety_audit_events_entity_idx ON safety.audit_events(entity_type, entity_id, created_at);

CREATE OR REPLACE FUNCTION safety.append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'safety append-only record cannot be changed';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER safety_evidence_append_only BEFORE UPDATE OR DELETE ON safety.evidence_snapshots FOR EACH ROW EXECUTE FUNCTION safety.append_only_guard();
CREATE TRIGGER safety_evidence_holds_append_only BEFORE UPDATE OR DELETE ON safety.evidence_holds FOR EACH ROW EXECUTE FUNCTION safety.append_only_guard();
CREATE TRIGGER safety_access_audit_append_only BEFORE UPDATE OR DELETE ON safety.case_access_audit FOR EACH ROW EXECUTE FUNCTION safety.append_only_guard();
CREATE TRIGGER safety_audit_append_only BEFORE UPDATE OR DELETE ON safety.audit_events FOR EACH ROW EXECUTE FUNCTION safety.append_only_guard();

-- +END UP

-- +BEGIN DOWN
DROP TRIGGER IF EXISTS safety_audit_append_only ON safety.audit_events;
DROP TRIGGER IF EXISTS safety_access_audit_append_only ON safety.case_access_audit;
DROP TRIGGER IF EXISTS safety_evidence_append_only ON safety.evidence_snapshots;
DROP TRIGGER IF EXISTS safety_evidence_holds_append_only ON safety.evidence_holds;
DROP FUNCTION IF EXISTS safety.append_only_guard();
DROP TABLE IF EXISTS safety.appeals;
DROP TABLE IF EXISTS safety.evidence_holds;
DROP TABLE IF EXISTS safety.actions;
DROP TABLE IF EXISTS safety.audit_events;
DROP TABLE IF EXISTS safety.case_access_audit;
DROP TABLE IF EXISTS safety.cases;
DROP TABLE IF EXISTS safety.evidence_snapshots;
DROP TABLE IF EXISTS safety.reports;
DROP TABLE IF EXISTS safety.blocks;
DROP SCHEMA IF EXISTS safety;
-- +END DOWN
