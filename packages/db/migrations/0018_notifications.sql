-- NTF-01: data-only notifications and durable provider outbox.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE notifications.notification_idempotency (
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  idempotency_digest text NOT NULL CHECK (idempotency_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, idempotency_digest)
);
CREATE TABLE notifications.preferences_idempotency (
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  idempotency_digest text NOT NULL CHECK (idempotency_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, idempotency_digest)
);
CREATE TABLE notifications.notifications (
  id uuid PRIMARY KEY,
  recipient_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  resource_kind text NOT NULL CHECK (resource_kind IN ('letter','conversation','connection','introduction','event','circle','safety_action')),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 64 AND resource_id ~ '^[A-Za-z0-9_.:-]+$'),
  event_key text NOT NULL CHECK (event_key IN ('letter.received','message.received','connection.created','introduction.available','event.reminder','circle.invitation','safety.action_required')),
  event_version integer NOT NULL CHECK (event_version > 0),
  category text NOT NULL CHECK (category IN ('letters','messages','connections','introductions','events','circles','critical-safety')),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
  read_at timestamptz,
  suppressed_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX notifications_recipient_cursor_idx ON notifications.notifications(recipient_account_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications.notifications(recipient_account_id, read_at) WHERE read_at IS NULL AND suppressed_at IS NULL;

CREATE OR REPLACE FUNCTION notifications.validate_event_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_category text;
BEGIN
  IF jsonb_typeof(NEW.parameters) <> 'object' THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  expected_category := CASE NEW.event_key
    WHEN 'letter.received' THEN 'letters' WHEN 'message.received' THEN 'messages'
    WHEN 'connection.created' THEN 'connections' WHEN 'introduction.available' THEN 'introductions'
    WHEN 'event.reminder' THEN 'events' WHEN 'circle.invitation' THEN 'circles'
    WHEN 'safety.action_required' THEN 'critical-safety' ELSE NULL END;
  IF expected_category IS NULL OR NEW.event_version <> 1 OR NEW.category <> expected_category THEN RAISE EXCEPTION 'notification event contract mismatch'; END IF;
  IF (NEW.event_key='letter.received' AND NEW.resource_kind <> 'letter') OR
     (NEW.event_key='message.received' AND NEW.resource_kind <> 'conversation') OR
     (NEW.event_key='connection.created' AND NEW.resource_kind <> 'connection') OR
     (NEW.event_key='introduction.available' AND NEW.resource_kind <> 'introduction') OR
     (NEW.event_key='event.reminder' AND NEW.resource_kind <> 'event') OR
     (NEW.event_key='circle.invitation' AND NEW.resource_kind <> 'circle') OR
     (NEW.event_key='safety.action_required' AND NEW.resource_kind <> 'safety_action') THEN RAISE EXCEPTION 'notification resource contract mismatch'; END IF;
  IF NEW.event_key='letter.received' AND ((SELECT count(*) FROM jsonb_object_keys(NEW.parameters)) <> 1 OR jsonb_typeof(NEW.parameters->'source') <> 'string' OR NEW.parameters->>'source' NOT IN ('member','desk')) THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  IF NEW.event_key='message.received' AND ((SELECT count(*) FROM jsonb_object_keys(NEW.parameters)) <> 1 OR jsonb_typeof(NEW.parameters->'conversation_type') <> 'string' OR NEW.parameters->>'conversation_type' NOT IN ('direct','group')) THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  IF NEW.event_key='connection.created' AND ((SELECT count(*) FROM jsonb_object_keys(NEW.parameters)) <> 1 OR jsonb_typeof(NEW.parameters->'mode') <> 'string' OR NEW.parameters->>'mode' NOT IN ('friends','activities','professional','dating')) THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  IF NEW.event_key='introduction.available' AND ((SELECT count(*) FROM jsonb_object_keys(NEW.parameters)) <> 1 OR jsonb_typeof(NEW.parameters->'batch') <> 'string' OR NEW.parameters->>'batch' NOT IN ('current','weekly')) THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  IF NEW.event_key='event.reminder' AND ((SELECT count(*) FROM jsonb_object_keys(NEW.parameters)) <> 1 OR jsonb_typeof(NEW.parameters->'hours_before') <> 'number' OR NEW.parameters->>'hours_before' NOT IN ('1','24')) THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  IF NEW.event_key='circle.invitation' AND ((SELECT count(*) FROM jsonb_object_keys(NEW.parameters)) <> 1 OR jsonb_typeof(NEW.parameters->'role') <> 'string' OR NEW.parameters->>'role' NOT IN ('member','moderator')) THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  IF NEW.event_key='safety.action_required' AND ((SELECT count(*) FROM jsonb_object_keys(NEW.parameters)) <> 1 OR jsonb_typeof(NEW.parameters->'action') <> 'string' OR NEW.parameters->>'action' NOT IN ('review','appeal','security')) THEN RAISE EXCEPTION 'notification parameters mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_event_contract_guard BEFORE INSERT OR UPDATE ON notifications.notifications FOR EACH ROW EXECUTE FUNCTION notifications.validate_event_contract();
CREATE TABLE notifications.provider_intents (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications.notifications(id) ON DELETE CASCADE,
  recipient_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email','push')),
  state text NOT NULL CHECK (state IN ('pending','leased','retrying','retained','sent','failed','suppressed')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  lease_fence integer NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  next_attempt_at timestamptz,
  digest_due_at timestamptz,
  digest_cadence_bucket text CHECK (digest_cadence_bucket IS NULL OR digest_cadence_bucket IN ('daily','weekly')),
  last_error_code text,
  provider_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(notification_id, channel),
  CHECK ((state = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state <> 'leased')
);
CREATE INDEX notifications_intent_due_idx ON notifications.provider_intents(state, available_at, next_attempt_at);
CREATE TABLE notifications.provider_attempts (
  id bigserial PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES notifications.provider_intents(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  outcome text NOT NULL CHECK (outcome IN ('accepted','retryable_failure','terminal_failure','suppressed')),
  error_code text,
  provider_id text,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE(intent_id, attempt_no)
);

CREATE TABLE notifications.preferences (
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app','email','push')),
  category text NOT NULL CHECK (category IN ('letters','messages','connections','introductions','events','circles','critical-safety')),
  enabled boolean NOT NULL,
  quiet_start_minute smallint NOT NULL CHECK (quiet_start_minute BETWEEN 0 AND 1439),
  quiet_end_minute smallint NOT NULL CHECK (quiet_end_minute BETWEEN 0 AND 1439),
  digest_cadence text NOT NULL CHECK (digest_cadence IN ('immediate','daily','weekly')),
  critical_safety_exception boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  updated_at timestamptz NOT NULL,
  CHECK (critical_safety_exception = (category = 'critical-safety')),
  PRIMARY KEY(account_id, channel, category)
);

CREATE OR REPLACE FUNCTION notifications.append_only_attempts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM notifications.provider_intents i JOIN notifications.notifications n ON n.id=i.notification_id JOIN iam.accounts a ON a.id=n.recipient_account_id WHERE i.id=OLD.intent_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'notification attempts are append-only';
END $$;
CREATE TRIGGER provider_attempts_append_only BEFORE UPDATE OR DELETE ON notifications.provider_attempts
FOR EACH ROW EXECUTE FUNCTION notifications.append_only_attempts();
CREATE OR REPLACE FUNCTION notifications.prevent_direct_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_text text;
BEGIN
  account_text := COALESCE(to_jsonb(OLD)->>'recipient_account_id', to_jsonb(OLD)->>'account_id');
  IF account_text IS NOT NULL AND EXISTS (SELECT 1 FROM iam.accounts WHERE id=account_text::uuid) THEN
    RAISE EXCEPTION 'notification durable records are retained until account erasure';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER notifications_delete_guard BEFORE DELETE ON notifications.notifications
FOR EACH ROW EXECUTE FUNCTION notifications.prevent_direct_delete();
CREATE TRIGGER provider_intents_delete_guard BEFORE DELETE ON notifications.provider_intents
FOR EACH ROW EXECUTE FUNCTION notifications.prevent_direct_delete();
CREATE TRIGGER notification_idempotency_delete_guard BEFORE DELETE ON notifications.notification_idempotency
FOR EACH ROW EXECUTE FUNCTION notifications.prevent_direct_delete();
CREATE TRIGGER preferences_idempotency_delete_guard BEFORE DELETE ON notifications.preferences_idempotency
FOR EACH ROW EXECUTE FUNCTION notifications.prevent_direct_delete();

CREATE OR REPLACE FUNCTION notifications.preferences_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version <= OLD.version THEN RAISE EXCEPTION 'notification preference version must increase'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preferences_version_guard BEFORE UPDATE ON notifications.preferences
FOR EACH ROW EXECUTE FUNCTION notifications.preferences_version_guard();
-- +END UP
-- +BEGIN DOWN
DROP TRIGGER IF EXISTS preferences_version_guard ON notifications.preferences;
DROP FUNCTION IF EXISTS notifications.preferences_version_guard();
DROP TRIGGER IF EXISTS notification_event_contract_guard ON notifications.notifications;
DROP FUNCTION IF EXISTS notifications.validate_event_contract();
DROP TRIGGER IF EXISTS provider_attempts_append_only ON notifications.provider_attempts;
DROP FUNCTION IF EXISTS notifications.append_only_attempts();
DROP TRIGGER IF EXISTS notifications_delete_guard ON notifications.notifications;
DROP TRIGGER IF EXISTS provider_intents_delete_guard ON notifications.provider_intents;
DROP TRIGGER IF EXISTS notification_idempotency_delete_guard ON notifications.notification_idempotency;
DROP TRIGGER IF EXISTS preferences_idempotency_delete_guard ON notifications.preferences_idempotency;
DROP FUNCTION IF EXISTS notifications.prevent_direct_delete();
DROP TABLE IF EXISTS notifications.preferences;
DROP TABLE IF EXISTS notifications.provider_attempts;
DROP TABLE IF EXISTS notifications.provider_intents;
DROP TABLE IF EXISTS notifications.notifications;
DROP TABLE IF EXISTS notifications.preferences_idempotency;
DROP TABLE IF EXISTS notifications.notification_idempotency;
DROP SCHEMA IF EXISTS notifications;
-- +END DOWN
