-- CIR-01: bounded circles, encrypted notes, and durable NTF handoff.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS circles;
-- SAF-01 remains the vault owner. CIR merely registers its two opaque target
-- kinds; no circle/note plaintext is ever copied into safety rows.
ALTER TABLE safety.reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE safety.reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('account','profile','message','media','event','circle','note'));
CREATE OR REPLACE FUNCTION circles.valid_topics_v1(input jsonb) RETURNS boolean
IMMUTABLE STRICT LANGUAGE sql AS $$
  SELECT CASE WHEN jsonb_typeof(input) <> 'array' THEN false ELSE
    jsonb_array_length(input) BETWEEN 1 AND 12
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(input) AS topic(value)
      WHERE value NOT IN ('culture','language_exchange','career','study','parenting','wellbeing','creative_practice','local_life','travel','relationships','mutual_aid','books')
    )
    AND (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements_text(input) AS topic(value))
  END
$$;
-- CIR owns the circles capability without retroactively editing ELG's frozen
-- migration. A circle never substitutes event visibility.
ALTER TABLE eligibility.partition_decisions DROP CONSTRAINT IF EXISTS partition_decisions_capability_check;
ALTER TABLE eligibility.partition_decisions ADD CONSTRAINT partition_decisions_capability_check
  CHECK (capability IN ('discover','introduce','direct_message','circles','event_visibility','dating'));
CREATE TABLE circles.circles (
  id uuid PRIMARY KEY,
  owner_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description_ciphertext text,
  description_nonce text,
  description_key_id text,
  lifecycle text NOT NULL CHECK (lifecycle IN ('draft','active','archived')),
  visibility text NOT NULL CHECK (visibility IN ('invitation_only','approval_required')),
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','dating')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('online','country','city')),
  country_code text,
  city_label text,
  topic_catalog_version smallint NOT NULL DEFAULT 1 CHECK (topic_catalog_version=1),
  topics jsonb NOT NULL CHECK (circles.valid_topics_v1(topics)),
  CONSTRAINT circles_scope_location_consistent CHECK (
    (scope_kind='online' AND country_code IS NULL AND city_label IS NULL)
    OR (scope_kind='country' AND country_code ~ '^[A-Z]{2}$' AND city_label IS NULL)
    OR (scope_kind='city' AND country_code ~ '^[A-Z]{2}$' AND city_label ~ '^[[:alnum:] .,''’\-]+$')
  ),
  member_cap integer NOT NULL CHECK (member_cap BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX circles_owner_idx ON circles.circles(owner_account_id,updated_at DESC,id DESC);
CREATE TABLE circles.memberships (
  id uuid PRIMARY KEY,
  circle_id uuid NOT NULL REFERENCES circles.circles(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','moderator','member')),
  state text NOT NULL CHECK (state IN ('active','pending','removed','left','rejected')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(circle_id,id)
);
CREATE UNIQUE INDEX circles_active_membership_unique ON circles.memberships(circle_id,account_id) WHERE state IN ('active','pending');
CREATE INDEX circles_membership_account_idx ON circles.memberships(account_id,state,circle_id);
-- Exact partial keysets for list() and listMembers(). INCLUDE keeps the
-- member-list role projection out of the ordering key.
CREATE INDEX circles_membership_account_active_cursor_idx
  ON circles.memberships(account_id,updated_at DESC,circle_id DESC) WHERE state='active';
CREATE INDEX circles_membership_circle_active_cursor_idx
  ON circles.memberships(circle_id,updated_at DESC,account_id DESC) INCLUDE(role) WHERE state='active';
CREATE TABLE circles.invitations (
  id uuid PRIMARY KEY,
  circle_id uuid NOT NULL REFERENCES circles.circles(id) ON DELETE CASCADE,
  inviter_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  invitee_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('member','moderator')),
  state text NOT NULL CHECK (state IN ('pending','accepted','declined','expired','cancelled')),
  -- Invitation identity is a generation, never a durable relationship.  A
  -- re-invite must therefore get a new id after this deadline, rather than
  -- turning an old notification back into a live invitation.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX circles_pending_invitation_unique ON circles.invitations(circle_id,invitee_account_id) WHERE state='pending';
CREATE TABLE circles.join_requests (
  id uuid PRIMARY KEY,
  circle_id uuid NOT NULL REFERENCES circles.circles(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  message_ciphertext text, message_nonce text, message_key_id text,
  state text NOT NULL CHECK (state IN ('pending','approved','rejected','cancelled')),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX circles_pending_join_unique ON circles.join_requests(circle_id,account_id) WHERE state='pending';
CREATE INDEX circles_pending_join_cursor_idx
  ON circles.join_requests(circle_id,created_at DESC,id DESC)
  INCLUDE(account_id,message_ciphertext,message_nonce,message_key_id) WHERE state='pending';
CREATE TABLE circles.notes (
  id uuid PRIMARY KEY,
  circle_id uuid NOT NULL REFERENCES circles.circles(id) ON DELETE CASCADE,
  author_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  body_ciphertext text NOT NULL, body_nonce text NOT NULL, body_key_id text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX circles_notes_cursor_idx ON circles.notes(circle_id,created_at ASC,id ASC);
CREATE TABLE circles.idempotency (
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  operation text NOT NULL, idempotency_digest text NOT NULL, payload_digest text NOT NULL,
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object'), created_at timestamptz NOT NULL,
  PRIMARY KEY(actor_account_id,operation,idempotency_digest)
);
CREATE TABLE circles.audit_events (
  id bigserial PRIMARY KEY, circle_id uuid REFERENCES circles.circles(id) ON DELETE CASCADE,
  actor_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('circle.created','circle.patched','circle.invited','circle.join_requested','circle.join_withdrawn','circle.invitation_accept','circle.invitation_decline','circle.invitation_cancel','circle.left','circle.member_approve','circle.member_decline','circle.member_remove','circle.member_role','circle.note_created')),
  subject_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object' AND NOT (metadata ?| ARRAY['body','description','message','ciphertext','nonce'])), created_at timestamptz NOT NULL
);
CREATE TABLE circles.notification_handoff (
  id uuid PRIMARY KEY, circle_id uuid NOT NULL REFERENCES circles.circles(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES circles.invitations(id) ON DELETE CASCADE,
  recipient_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('member','moderator')), event_key text NOT NULL CHECK (event_key='circle.invitation'),
  state text NOT NULL CHECK (state IN ('pending','leased','sent','retrying','failed','suppressed','cancelled')), attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  lease_token uuid, lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence>=0), max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  idempotency_digest text NOT NULL CHECK (idempotency_digest ~ '^[0-9a-f]{64}$'), available_at timestamptz NOT NULL,
  last_error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(invitation_id), UNIQUE(circle_id,recipient_account_id,idempotency_digest)
);
CREATE INDEX circles_handoff_due_idx ON circles.notification_handoff(state,available_at);
ALTER TABLE circles.circles ADD CONSTRAINT circles_description_cipher_consistent CHECK (
  (description_ciphertext IS NULL AND description_nonce IS NULL AND description_key_id IS NULL)
  OR (description_ciphertext IS NOT NULL AND description_nonce IS NOT NULL AND description_key_id IS NOT NULL)
);
ALTER TABLE circles.join_requests ADD CONSTRAINT circles_join_message_cipher_consistent CHECK (
  (message_ciphertext IS NULL AND message_nonce IS NULL AND message_key_id IS NULL)
  OR (message_ciphertext IS NOT NULL AND message_nonce IS NOT NULL AND message_key_id IS NOT NULL)
);
CREATE OR REPLACE FUNCTION circles.append_only_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_id uuid := (SELECT c.owner_account_id FROM circles.circles c WHERE c.id=OLD.circle_id);
BEGIN
  IF TG_OP='UPDATE' THEN
    -- The only legal updates are the PostgreSQL FK ON DELETE SET NULL
    -- transitions for either account reference. A session GUC (or a direct
    -- UPDATE to NULL) is not proof of a referential-action cascade.
    IF NEW.circle_id IS DISTINCT FROM OLD.circle_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.metadata IS DISTINCT FROM OLD.metadata
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NOT (
         NEW.actor_account_id IS NOT DISTINCT FROM OLD.actor_account_id
         OR (OLD.actor_account_id IS NOT NULL AND NEW.actor_account_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM iam.accounts WHERE id=OLD.actor_account_id))
       )
       OR NOT (
         NEW.subject_account_id IS NOT DISTINCT FROM OLD.subject_account_id
         OR (OLD.subject_account_id IS NOT NULL AND NEW.subject_account_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM iam.accounts WHERE id=OLD.subject_account_id))
       )
       OR (NEW.actor_account_id IS NOT DISTINCT FROM OLD.actor_account_id
           AND NEW.subject_account_id IS NOT DISTINCT FROM OLD.subject_account_id)
    THEN RAISE EXCEPTION 'circle audit is append-only'; END IF;
    RETURN NEW;
  END IF;
  -- FK cascades execute below the parent RI trigger. Direct SQL stays at
  -- depth 1 and cannot manufacture this database-maintained fact with a GUC.
  IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF (OLD.actor_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM iam.accounts WHERE id=OLD.actor_account_id))
     OR (owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM iam.accounts WHERE id=owner_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'circle audit is append-only';
END $$;
CREATE TRIGGER circles_audit_append_only BEFORE UPDATE OR DELETE ON circles.audit_events FOR EACH ROW EXECUTE FUNCTION circles.append_only_audit();
CREATE OR REPLACE FUNCTION circles.frozen_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_id uuid := COALESCE((to_jsonb(OLD)->>'account_id')::uuid,(to_jsonb(OLD)->>'owner_account_id')::uuid,(to_jsonb(OLD)->>'author_account_id')::uuid,(to_jsonb(OLD)->>'recipient_account_id')::uuid,(to_jsonb(OLD)->>'invitee_account_id')::uuid,(to_jsonb(OLD)->>'actor_account_id')::uuid);
  owner_id uuid := (SELECT c.owner_account_id FROM circles.circles c WHERE c.id=(to_jsonb(OLD)->>'circle_id')::uuid);
BEGIN
  IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF (account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM iam.accounts WHERE id=account_id))
     OR (owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM iam.accounts WHERE id=owner_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'circle durable row is frozen';
END $$;
CREATE TRIGGER circles_audit_delete_guard BEFORE DELETE ON circles.audit_events FOR EACH ROW EXECUTE FUNCTION circles.frozen_delete_guard();
CREATE TRIGGER circles_idempotency_delete_guard BEFORE DELETE ON circles.idempotency FOR EACH ROW EXECUTE FUNCTION circles.frozen_delete_guard();
CREATE TRIGGER circles_notes_delete_guard BEFORE DELETE ON circles.notes FOR EACH ROW EXECUTE FUNCTION circles.frozen_delete_guard();
CREATE TRIGGER circles_invitations_delete_guard BEFORE DELETE ON circles.invitations FOR EACH ROW EXECUTE FUNCTION circles.frozen_delete_guard();
CREATE TRIGGER circles_join_requests_delete_guard BEFORE DELETE ON circles.join_requests FOR EACH ROW EXECUTE FUNCTION circles.frozen_delete_guard();
CREATE TRIGGER circles_handoff_delete_guard BEFORE DELETE ON circles.notification_handoff FOR EACH ROW EXECUTE FUNCTION circles.frozen_delete_guard();
CREATE OR REPLACE FUNCTION circles.validate_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role='owner' AND NEW.state='active' AND NOT EXISTS (SELECT 1 FROM iam.accounts WHERE id=NEW.account_id AND state='enabled') THEN RAISE EXCEPTION 'circle owner unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER circles_owner_guard BEFORE INSERT OR UPDATE ON circles.memberships FOR EACH ROW EXECUTE FUNCTION circles.validate_owner();
CREATE OR REPLACE FUNCTION circles.prevent_circle_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM iam.accounts WHERE id=OLD.owner_account_id) THEN
    RAISE EXCEPTION 'circle durable row is frozen';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER circles_parent_delete_guard BEFORE DELETE ON circles.circles FOR EACH ROW EXECUTE FUNCTION circles.prevent_circle_delete();
-- +END UP
-- +BEGIN DOWN
-- SAF evidence is append-only. Preserve existing CIR reports across a
-- downgrade, while preventing new retired target kinds. NOT VALID keeps the
-- evidence rows legally intact and still enforces the old vocabulary for new
-- writes; re-upgrade restores the expanded valid constraint.
ALTER TABLE safety.reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE safety.reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('account','profile','message','media','event')) NOT VALID;
DROP TRIGGER IF EXISTS circles_owner_guard ON circles.memberships;
DROP FUNCTION IF EXISTS circles.validate_owner();
DROP TRIGGER IF EXISTS circles_parent_delete_guard ON circles.circles;
DROP FUNCTION IF EXISTS circles.prevent_circle_delete();
DROP TRIGGER IF EXISTS circles_idempotency_delete_guard ON circles.idempotency;
DROP TRIGGER IF EXISTS circles_notes_delete_guard ON circles.notes;
DROP TRIGGER IF EXISTS circles_invitations_delete_guard ON circles.invitations;
DROP TRIGGER IF EXISTS circles_join_requests_delete_guard ON circles.join_requests;
DROP TRIGGER IF EXISTS circles_handoff_delete_guard ON circles.notification_handoff;
DROP TRIGGER IF EXISTS circles_audit_delete_guard ON circles.audit_events;
DROP TRIGGER IF EXISTS circles_audit_append_only ON circles.audit_events;
DROP FUNCTION IF EXISTS circles.frozen_delete_guard();
DROP FUNCTION IF EXISTS circles.append_only_audit();
DROP TABLE IF EXISTS circles.notification_handoff;
DROP TABLE IF EXISTS circles.audit_events;
DROP TABLE IF EXISTS circles.idempotency;
DROP TABLE IF EXISTS circles.notes;
DROP TABLE IF EXISTS circles.join_requests;
DROP TABLE IF EXISTS circles.invitations;
DROP TABLE IF EXISTS circles.memberships;
DROP TABLE IF EXISTS circles.circles;
DROP FUNCTION IF EXISTS circles.valid_topics_v1(jsonb);
-- Retain append-only ELG capability evidence across a downgrade, while the
-- prior vocabulary still rejects new `circles` decisions. NOT VALID leaves
-- existing snapshots intact and is replaced by the validated expanded check
-- when this migration is re-applied.
ALTER TABLE eligibility.partition_decisions DROP CONSTRAINT IF EXISTS partition_decisions_capability_check;
ALTER TABLE eligibility.partition_decisions ADD CONSTRAINT partition_decisions_capability_check
  CHECK (capability IN ('discover','introduce','direct_message','event_visibility','dating')) NOT VALID;
DROP SCHEMA IF EXISTS circles;
-- +END DOWN
