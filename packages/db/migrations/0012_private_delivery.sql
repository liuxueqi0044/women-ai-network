-- PVL-01: immutable, encrypted private-letter delivery.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS private_delivery;

CREATE TABLE private_delivery.deliveries (
  id uuid PRIMARY KEY,
  sender_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connection.connections(id) ON DELETE CASCADE,
  connection_epoch integer NOT NULL CHECK (connection_epoch >= 0),
  letter_id uuid REFERENCES letters.letters(id) ON DELETE SET NULL,
  revision_id uuid REFERENCES letters.letter_revisions(id) ON DELETE SET NULL,
  revision integer NOT NULL CHECK (revision > 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose = 'private_letter_delivery'),
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  state text NOT NULL CHECK (state IN ('queued','leased','delivered','cancelled','failed')),
  snapshot_title_ciphertext text NOT NULL,
  snapshot_title_nonce text NOT NULL,
  snapshot_body_ciphertext text NOT NULL,
  snapshot_body_nonce text NOT NULL,
  snapshot_metadata_ciphertext text NOT NULL,
  snapshot_metadata_nonce text NOT NULL,
  snapshot_key_id text NOT NULL CHECK (length(snapshot_key_id) BETWEEN 1 AND 128),
  snapshot_policy_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_policy_json) = 'object'),
  lease_owner text,
  lease_token_digest text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  read_at timestamptz,
  recipient_hidden_at timestamptz,
  sender_withdrawn_at timestamptz,
  UNIQUE(sender_id, recipient_id, connection_id, connection_epoch, letter_id, revision, purpose),
  CHECK (sender_id <> recipient_id),
  CHECK (state <> 'queued' OR (lease_owner IS NULL AND lease_token_digest IS NULL AND lease_until IS NULL AND delivered_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL)),
  CHECK (state <> 'leased' OR (lease_owner IS NOT NULL AND lease_token_digest IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state <> 'delivered' OR delivered_at IS NOT NULL),
  CHECK (state <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (state <> 'failed' OR failed_at IS NOT NULL),
  CHECK (attempts <= max_attempts)
);
CREATE INDEX private_delivery_recipient_idx ON private_delivery.deliveries(recipient_id, created_at DESC, id DESC);
CREATE INDEX private_delivery_sender_idx ON private_delivery.deliveries(sender_id, created_at DESC, id DESC);
CREATE INDEX private_delivery_claim_idx ON private_delivery.deliveries(state, lease_until, created_at, id);

-- PostgreSQL-authoritative wake intents. BullMQ jobs are disposable hints;
-- these rows survive queue exhaustion, queue outages, and worker restarts.
CREATE TABLE private_delivery.wake_intents (
  delivery_id uuid NOT NULL REFERENCES private_delivery.deliveries(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('delivery','notification')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 20 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, kind),
  CHECK (state = 'pending' OR last_error_code IS NOT NULL OR state = 'suppressed')
);
CREATE INDEX private_delivery_wake_due_idx ON private_delivery.wake_intents(state, available_at, delivery_id);

CREATE TABLE private_delivery.idempotency_keys (
  sender_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  delivery_id uuid NOT NULL REFERENCES private_delivery.deliveries(id) ON DELETE CASCADE,
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(sender_id, key_digest)
);

CREATE TABLE private_delivery.transitions (
  id bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES private_delivery.deliveries(id) ON DELETE CASCADE,
  from_state text CHECK (from_state IS NULL OR from_state IN ('queued','leased','delivered','cancelled','failed')),
  to_state text NOT NULL CHECK (to_state IN ('queued','leased','delivered','cancelled','failed')),
  actor_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL
);
CREATE INDEX private_delivery_transitions_idx ON private_delivery.transitions(delivery_id, created_at);

CREATE TABLE private_delivery.notification_outbox (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES private_delivery.deliveries(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type = 'private_delivery.delivered'),
  payload_json jsonb NOT NULL CHECK (
    jsonb_typeof(payload_json) = 'object'
    AND payload_json ? 'delivery_id'
    AND NOT (payload_json::text ILIKE '%title%' OR payload_json::text ILIKE '%body%' OR payload_json::text ILIKE '%pen_name%')
  ),
  state text NOT NULL CHECK (state IN ('pending','dispatched','cancelled')) DEFAULT 'pending',
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  UNIQUE(delivery_id, event_type)
);

CREATE TABLE private_delivery.evidence_snapshots (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES private_delivery.deliveries(id) ON DELETE CASCADE,
  captured_by uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 64),
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL,
  legal_hold boolean NOT NULL DEFAULT true,
  UNIQUE(delivery_id, category)
);

CREATE OR REPLACE FUNCTION private_delivery.append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'private delivery append-only record cannot be changed';
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_id uuid;
  letter_kind text;
  revision_hash text;
  connection_mode text;
BEGIN
  SELECT l.owner_id,l.kind,r.source_hash INTO owner_id,letter_kind,revision_hash
    FROM letters.letters l JOIN letters.letter_revisions r ON r.letter_id=l.id
   WHERE l.id=NEW.letter_id AND r.id=NEW.revision_id AND r.revision=NEW.revision;
  IF owner_id IS NULL OR owner_id <> NEW.sender_id OR letter_kind <> 'private_letter' OR revision_hash <> NEW.source_hash THEN
    RAISE EXCEPTION 'private delivery letter revision binding is invalid';
  END IF;
  SELECT c.mode INTO connection_mode FROM connection.connections c
   WHERE c.id=NEW.connection_id AND c.state='accepted' AND c.version=NEW.connection_epoch
     AND c.mode=NEW.mode
     AND ((c.requester_account_id=NEW.sender_id AND c.recipient_account_id=NEW.recipient_id)
       OR (c.requester_account_id=NEW.recipient_id AND c.recipient_account_id=NEW.sender_id));
  IF connection_mode IS NULL THEN RAISE EXCEPTION 'private delivery connection binding is invalid'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.connection_epoch IS DISTINCT FROM OLD.connection_epoch
     OR NEW.letter_id IS DISTINCT FROM OLD.letter_id OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.snapshot_title_ciphertext IS DISTINCT FROM OLD.snapshot_title_ciphertext
     OR NEW.snapshot_title_nonce IS DISTINCT FROM OLD.snapshot_title_nonce
     OR NEW.snapshot_body_ciphertext IS DISTINCT FROM OLD.snapshot_body_ciphertext
     OR NEW.snapshot_body_nonce IS DISTINCT FROM OLD.snapshot_body_nonce
     OR NEW.snapshot_metadata_ciphertext IS DISTINCT FROM OLD.snapshot_metadata_ciphertext
     OR NEW.snapshot_metadata_nonce IS DISTINCT FROM OLD.snapshot_metadata_nonce
     OR NEW.snapshot_key_id IS DISTINCT FROM OLD.snapshot_key_id
     OR NEW.snapshot_policy_json IS DISTINCT FROM OLD.snapshot_policy_json THEN
    RAISE EXCEPTION 'private delivery identity or snapshot is immutable';
  END IF;
  IF NEW.state = OLD.state THEN
    IF NEW.state IN ('queued','cancelled','failed') THEN
      IF NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
         OR NEW.lease_token_digest IS DISTINCT FROM OLD.lease_token_digest OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
         OR NEW.available_at IS DISTINCT FROM OLD.available_at
         OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
         OR NEW.failed_at IS DISTINCT FROM OLD.failed_at THEN
        RAISE EXCEPTION 'terminal delivery fields are immutable';
      END IF;
    ELSIF NEW.state = 'leased' THEN
      IF OLD.lease_until IS NULL OR OLD.lease_until > now()
         OR NEW.attempts <> OLD.attempts + 1 OR NEW.lease_owner IS NULL OR NEW.lease_token_digest IS NULL OR NEW.lease_until IS NULL
         OR NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
         OR NEW.lease_token_digest IS NOT DISTINCT FROM OLD.lease_token_digest
         OR NEW.lease_until <= now() THEN
        RAISE EXCEPTION 'lease transition is invalid';
      END IF;
    ELSE
      IF NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
         OR NEW.lease_token_digest IS DISTINCT FROM OLD.lease_token_digest OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
         OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
         OR NEW.failed_at IS DISTINCT FROM OLD.failed_at THEN
        RAISE EXCEPTION 'delivered delivery fields are immutable';
      END IF;
    END IF;
    IF (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
       OR (OLD.recipient_hidden_at IS NOT NULL AND NEW.recipient_hidden_at IS DISTINCT FROM OLD.recipient_hidden_at)
       OR (OLD.sender_withdrawn_at IS NOT NULL AND NEW.sender_withdrawn_at IS DISTINCT FROM OLD.sender_withdrawn_at) THEN
      RAISE EXCEPTION 'delivery viewer timestamps are monotonic';
    END IF;
    IF NEW.read_at IS NOT NULL AND OLD.read_at IS NULL AND NEW.read_at < OLD.created_at THEN RAISE EXCEPTION 'read timestamp is invalid'; END IF;
    IF NEW.recipient_hidden_at IS NOT NULL AND OLD.recipient_hidden_at IS NULL AND NEW.recipient_hidden_at < OLD.created_at THEN RAISE EXCEPTION 'hidden timestamp is invalid'; END IF;
    IF NEW.sender_withdrawn_at IS NOT NULL AND OLD.sender_withdrawn_at IS NULL AND NEW.sender_withdrawn_at < OLD.created_at THEN RAISE EXCEPTION 'withdraw timestamp is invalid'; END IF;
  ELSIF OLD.state = 'queued' AND NEW.state = 'leased' THEN
    IF NEW.attempts <> OLD.attempts + 1 OR NEW.lease_owner IS NULL OR NEW.lease_token_digest IS NULL
       OR NEW.lease_until IS NULL OR NEW.lease_until <= now()
       OR NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
       OR NEW.lease_token_digest IS NOT DISTINCT FROM OLD.lease_token_digest THEN
      RAISE EXCEPTION 'initial lease claim is invalid';
    END IF;
  ELSIF OLD.state = 'leased' AND NEW.state = 'queued' THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.lease_owner IS NOT NULL
       OR NEW.lease_token_digest IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
      RAISE EXCEPTION 'lease release is invalid';
    END IF;
  ELSIF NOT (
    (OLD.state = 'queued' AND NEW.state IN ('leased','cancelled','failed')) OR
    (OLD.state = 'leased' AND NEW.state IN ('queued','delivered','cancelled','failed'))
  ) THEN
    RAISE EXCEPTION 'private delivery state transition is invalid';
  END IF;
  IF NEW.state <> 'leased' AND (NEW.lease_owner IS NOT NULL OR NEW.lease_token_digest IS NOT NULL OR NEW.lease_until IS NOT NULL) THEN
    RAISE EXCEPTION 'non-leased delivery cannot retain lease';
  END IF;
  IF NEW.state = 'delivered' AND (NEW.delivered_at IS NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL) THEN RAISE EXCEPTION 'delivered timestamps are invalid'; END IF;
  IF NEW.state = 'cancelled' AND (NEW.cancelled_at IS NULL OR NEW.delivered_at IS NOT NULL OR NEW.failed_at IS NOT NULL) THEN RAISE EXCEPTION 'cancelled timestamps are invalid'; END IF;
  IF NEW.state = 'failed' AND (NEW.failed_at IS NULL OR NEW.delivered_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL) THEN RAISE EXCEPTION 'failed timestamps are invalid'; END IF;
  IF NEW.state = 'queued' AND NEW.available_at IS NULL THEN RAISE EXCEPTION 'queued delivery availability is required'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.initial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'queued' OR NEW.attempts <> 0 OR NEW.created_at IS NULL OR NEW.available_at IS NULL
     OR NEW.delivered_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL
     OR NEW.read_at IS NOT NULL OR NEW.recipient_hidden_at IS NOT NULL OR NEW.sender_withdrawn_at IS NOT NULL OR NEW.lease_owner IS NOT NULL
     OR NEW.lease_token_digest IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
    RAISE EXCEPTION 'private delivery initial state is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivery_recipient uuid; delivery_state text;
BEGIN
  SELECT recipient_id,state INTO delivery_recipient,delivery_state FROM private_delivery.deliveries WHERE id=NEW.delivery_id;
  IF delivery_state <> 'delivered' OR delivery_recipient IS DISTINCT FROM NEW.recipient_id
     OR NEW.payload_json <> jsonb_build_object('delivery_id', NEW.delivery_id::text, 'event', 'private_delivery.delivered') THEN
    RAISE EXCEPTION 'outbox payload or delivery binding is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.outbox_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'outbox identity is immutable'; END IF;
  IF OLD.state <> 'pending' OR NEW.state NOT IN ('dispatched','cancelled') THEN RAISE EXCEPTION 'outbox transition is invalid'; END IF;
  IF NEW.state='dispatched' AND NEW.dispatched_at IS NULL THEN RAISE EXCEPTION 'outbox dispatch timestamp is required'; END IF;
  IF NEW.state='cancelled' AND NEW.dispatched_at IS NOT NULL THEN RAISE EXCEPTION 'cancelled outbox cannot be dispatched'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.wake_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'wake intent identity is immutable';
  END IF;
  IF NEW.attempts < OLD.attempts AND NOT (OLD.state='failed' AND NEW.state='pending' AND NEW.attempts=0) THEN
    RAISE EXCEPTION 'wake intent attempts cannot decrease';
  END IF;
  IF NEW.state <> 'pending' AND NEW.last_error_code IS NULL AND NEW.state <> 'suppressed' THEN
    RAISE EXCEPTION 'failed wake intent requires an error';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.idempotency_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d_sender uuid; d_recipient uuid; d_state text; d_revision integer; result_delivery text; result_sender text; result_recipient text; result_revision integer;
BEGIN
  SELECT sender_id,recipient_id,state,revision INTO d_sender,d_recipient,d_state,d_revision
    FROM private_delivery.deliveries WHERE id=NEW.delivery_id;
  IF d_sender IS NULL OR d_sender IS DISTINCT FROM NEW.sender_id THEN
    RAISE EXCEPTION 'idempotency delivery sender binding is invalid';
  END IF;
  result_delivery := NEW.result_json->>'deliveryId';
  result_sender := NEW.result_json->>'senderAccountId';
  result_recipient := NEW.result_json->>'recipientAccountId';
  result_revision := NULLIF(NEW.result_json->>'revision','')::integer;
  IF result_delivery IS DISTINCT FROM NEW.delivery_id::text
     OR result_sender IS DISTINCT FROM d_sender::text
     OR result_recipient IS DISTINCT FROM d_recipient::text
     OR result_revision IS DISTINCT FROM d_revision
     OR NEW.result_json->>'state' IS DISTINCT FROM d_state
     OR NEW.result_json ? 'content' THEN
    RAISE EXCEPTION 'idempotency result binding is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private_delivery.evidence_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sender_id uuid; recipient_id uuid; source_hash text;
BEGIN
  SELECT d.sender_id,d.recipient_id,d.source_hash INTO sender_id,recipient_id,source_hash FROM private_delivery.deliveries d WHERE d.id=NEW.delivery_id;
  IF NEW.captured_by IS DISTINCT FROM sender_id AND NEW.captured_by IS DISTINCT FROM recipient_id THEN RAISE EXCEPTION 'evidence actor is not a participant'; END IF;
  IF source_hash IS NULL OR NEW.source_hash IS DISTINCT FROM source_hash THEN RAISE EXCEPTION 'evidence source binding is invalid'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_initial_guard BEFORE INSERT ON private_delivery.deliveries FOR EACH ROW EXECUTE FUNCTION private_delivery.initial_guard();
CREATE TRIGGER delivery_insert_guard BEFORE INSERT ON private_delivery.deliveries FOR EACH ROW EXECUTE FUNCTION private_delivery.insert_guard();
CREATE TRIGGER delivery_transition_guard BEFORE UPDATE ON private_delivery.deliveries FOR EACH ROW EXECUTE FUNCTION private_delivery.transition_guard();
CREATE TRIGGER delivery_idempotency_append_only BEFORE UPDATE OR DELETE ON private_delivery.idempotency_keys FOR EACH ROW EXECUTE FUNCTION private_delivery.append_only_guard();
CREATE TRIGGER delivery_idempotency_insert_guard BEFORE INSERT ON private_delivery.idempotency_keys FOR EACH ROW EXECUTE FUNCTION private_delivery.idempotency_insert_guard();
CREATE TRIGGER delivery_transitions_append_only BEFORE UPDATE OR DELETE ON private_delivery.transitions FOR EACH ROW EXECUTE FUNCTION private_delivery.append_only_guard();
CREATE TRIGGER delivery_outbox_insert_guard BEFORE INSERT ON private_delivery.notification_outbox FOR EACH ROW EXECUTE FUNCTION private_delivery.outbox_guard();
CREATE TRIGGER delivery_outbox_transition_guard BEFORE UPDATE ON private_delivery.notification_outbox FOR EACH ROW EXECUTE FUNCTION private_delivery.outbox_transition_guard();
CREATE TRIGGER delivery_outbox_append_only BEFORE DELETE ON private_delivery.notification_outbox FOR EACH ROW EXECUTE FUNCTION private_delivery.append_only_guard();
CREATE TRIGGER delivery_wake_intent_guard BEFORE UPDATE ON private_delivery.wake_intents FOR EACH ROW EXECUTE FUNCTION private_delivery.wake_intent_guard();
CREATE TRIGGER delivery_evidence_insert_guard BEFORE INSERT ON private_delivery.evidence_snapshots FOR EACH ROW EXECUTE FUNCTION private_delivery.evidence_insert_guard();
CREATE TRIGGER delivery_evidence_append_only BEFORE UPDATE OR DELETE ON private_delivery.evidence_snapshots FOR EACH ROW EXECUTE FUNCTION private_delivery.append_only_guard();

-- +END UP
-- +BEGIN DOWN
DROP TRIGGER IF EXISTS delivery_evidence_append_only ON private_delivery.evidence_snapshots;
DROP TRIGGER IF EXISTS delivery_evidence_insert_guard ON private_delivery.evidence_snapshots;
DROP TRIGGER IF EXISTS delivery_outbox_append_only ON private_delivery.notification_outbox;
DROP TRIGGER IF EXISTS delivery_wake_intent_guard ON private_delivery.wake_intents;
DROP TRIGGER IF EXISTS delivery_outbox_transition_guard ON private_delivery.notification_outbox;
DROP TRIGGER IF EXISTS delivery_outbox_insert_guard ON private_delivery.notification_outbox;
DROP TRIGGER IF EXISTS delivery_transitions_append_only ON private_delivery.transitions;
DROP TRIGGER IF EXISTS delivery_transition_guard ON private_delivery.deliveries;
DROP TRIGGER IF EXISTS delivery_idempotency_append_only ON private_delivery.idempotency_keys;
DROP TRIGGER IF EXISTS delivery_idempotency_insert_guard ON private_delivery.idempotency_keys;
DROP TRIGGER IF EXISTS delivery_insert_guard ON private_delivery.deliveries;
DROP TRIGGER IF EXISTS delivery_initial_guard ON private_delivery.deliveries;
DROP FUNCTION IF EXISTS private_delivery.append_only_guard();
DROP FUNCTION IF EXISTS private_delivery.transition_guard();
DROP FUNCTION IF EXISTS private_delivery.initial_guard();
DROP FUNCTION IF EXISTS private_delivery.insert_guard();
DROP FUNCTION IF EXISTS private_delivery.outbox_guard();
DROP FUNCTION IF EXISTS private_delivery.outbox_transition_guard();
DROP FUNCTION IF EXISTS private_delivery.wake_intent_guard();
DROP FUNCTION IF EXISTS private_delivery.idempotency_insert_guard();
DROP FUNCTION IF EXISTS private_delivery.evidence_insert_guard();
DROP TABLE IF EXISTS private_delivery.evidence_snapshots;
DROP TABLE IF EXISTS private_delivery.notification_outbox;
DROP TABLE IF EXISTS private_delivery.wake_intents;
DROP TABLE IF EXISTS private_delivery.transitions;
DROP TABLE IF EXISTS private_delivery.idempotency_keys;
DROP TABLE IF EXISTS private_delivery.deliveries;
DROP SCHEMA IF EXISTS private_delivery;
-- +END DOWN
