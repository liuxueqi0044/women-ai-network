-- MSG-01: connection-bound conversations. Bodies and drafts are encrypted at rest.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS messaging;

CREATE TABLE messaging.conversations (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connection.connections(id) ON DELETE CASCADE,
  connection_epoch integer NOT NULL CHECK (connection_epoch >= 0),
  account_a uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  account_b uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  opening_delivery_id uuid,
  opening_revision integer,
  opening_source_hash text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','closed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (account_a <> account_b),
  CHECK ((opening_delivery_id IS NULL AND opening_revision IS NULL AND opening_source_hash IS NULL)
      OR (opening_delivery_id IS NOT NULL AND opening_revision > 0 AND opening_source_hash ~ '^[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX messaging_conversation_epoch_unique ON messaging.conversations(connection_id, connection_epoch) WHERE state='active';
CREATE INDEX messaging_conversation_member_idx ON messaging.conversations(account_a, updated_at DESC, id DESC);
CREATE INDEX messaging_conversation_member_b_idx ON messaging.conversations(account_b, updated_at DESC, id DESC);

CREATE TABLE messaging.messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  client_message_id uuid NOT NULL,
  idempotency_key_digest text NOT NULL CHECK (idempotency_key_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  server_sequence bigint NOT NULL CHECK (server_sequence > 0),
  body_ciphertext text NOT NULL,
  body_nonce text NOT NULL,
  body_key_id text NOT NULL CHECK (length(body_key_id) BETWEEN 1 AND 128),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','withdrawn')),
  created_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  UNIQUE(conversation_id, server_sequence),
  UNIQUE(conversation_id, sender_id, client_message_id),
  UNIQUE(sender_id, idempotency_key_digest),
  CHECK ((state='active' AND withdrawn_at IS NULL) OR (state='withdrawn' AND withdrawn_at IS NOT NULL))
);
CREATE INDEX messaging_history_idx ON messaging.messages(conversation_id, server_sequence DESC);

CREATE TABLE messaging.receipts (
  message_id uuid NOT NULL REFERENCES messaging.messages(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  delivered_at timestamptz,
  read_at timestamptz,
  PRIMARY KEY(message_id, viewer_id),
  CHECK (read_at IS NULL OR delivered_at IS NOT NULL)
);

CREATE TABLE messaging.notification_outbox (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messaging.messages(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type='message.wake'),
  payload_json jsonb NOT NULL CHECK (payload_json = jsonb_build_object('conversation_id', conversation_id::text, 'message_id', message_id::text, 'event', 'message.wake')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatched','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  UNIQUE(message_id, recipient_id)
);

CREATE TABLE messaging.ai_drafts (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  key_id text NOT NULL,
  provider text NOT NULL CHECK (provider <> ''),
  consent_json jsonb NOT NULL CHECK (consent_json->>'provider'='true' AND consent_json->>'retention'='short_term'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX messaging_ai_draft_expiry_idx ON messaging.ai_drafts(owner_id, expires_at);

CREATE OR REPLACE FUNCTION messaging.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'messaging immutable record cannot be changed'; END; $$;
CREATE OR REPLACE FUNCTION messaging.draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext OR NEW.nonce IS DISTINCT FROM OLD.nonce OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.consent_json IS DISTINCT FROM OLD.consent_json OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'ai draft identity/content immutable'; END IF;
  IF OLD.deleted_at IS NOT NULL OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_at < OLD.created_at) THEN RAISE EXCEPTION 'ai draft tombstone is invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION messaging.message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text; current_version integer; current_mode text; current_a uuid; current_b uuid; conversation_epoch integer; conversation_mode text;
BEGIN
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.client_message_id IS DISTINCT FROM OLD.client_message_id OR NEW.idempotency_key_digest IS DISTINCT FROM OLD.idempotency_key_digest OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.server_sequence IS DISTINCT FROM OLD.server_sequence OR NEW.body_ciphertext IS DISTINCT FROM OLD.body_ciphertext OR NEW.body_nonce IS DISTINCT FROM OLD.body_nonce OR NEW.body_key_id IS DISTINCT FROM OLD.body_key_id OR NEW.body_hash IS DISTINCT FROM OLD.body_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'message identity/body immutable'; END IF;
  SELECT m.connection_epoch,m.mode,c.state,c.version,c.mode,c.account_a,c.account_b INTO conversation_epoch,conversation_mode,current_state,current_version,current_mode,current_a,current_b
    FROM messaging.conversations m JOIN connection.connections c ON c.id=m.connection_id
   WHERE m.id=NEW.conversation_id AND m.state='active';
  IF current_state IS DISTINCT FROM 'accepted' OR current_version IS DISTINCT FROM conversation_epoch OR current_mode IS DISTINCT FROM conversation_mode
     OR NOT EXISTS (SELECT 1 FROM iam.accounts a WHERE a.id=current_a AND a.state='enabled')
     OR NOT EXISTS (SELECT 1 FROM iam.accounts b WHERE b.id=current_b AND b.state='enabled')
     OR EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND ((bl.blocker_account_id=current_a AND bl.blocked_account_id=current_b) OR (bl.blocker_account_id=current_b AND bl.blocked_account_id=current_a)))
  THEN RAISE EXCEPTION 'message connection binding is no longer current'; END IF;
  IF OLD.state='withdrawn' AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'message withdrawal is final'; END IF;
  IF OLD.state='withdrawn' AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN RAISE EXCEPTION 'message tombstone is immutable'; END IF;
  IF OLD.state='active' AND NEW.state='withdrawn' AND NEW.withdrawn_at IS NULL THEN RAISE EXCEPTION 'withdrawn timestamp required'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION messaging.conversation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ca uuid; cb uuid; cm text; cv integer; cs text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.connection_epoch IS DISTINCT FROM OLD.connection_epoch OR NEW.account_a IS DISTINCT FROM OLD.account_a OR NEW.account_b IS DISTINCT FROM OLD.account_b OR NEW.mode IS DISTINCT FROM OLD.mode) THEN RAISE EXCEPTION 'conversation identity is immutable'; END IF;
  IF TG_OP='UPDATE' AND OLD.state='closed' AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'conversation close is final'; END IF;
  -- Even a closed row must be bound to a real connection identity and exact
  -- epoch/mode/pair; closed is the only state that may outlive acceptance,
  -- account enablement, or a block.
  SELECT c.account_a,c.account_b,c.mode,c.version,c.state INTO ca,cb,cm,cv,cs
    FROM connection.connections c WHERE c.id=NEW.connection_id;
  IF cv IS DISTINCT FROM NEW.connection_epoch OR cm IS DISTINCT FROM NEW.mode OR NOT ((ca=NEW.account_a AND cb=NEW.account_b) OR (ca=NEW.account_b AND cb=NEW.account_a)) THEN RAISE EXCEPTION 'conversation connection binding is invalid'; END IF;
  IF NEW.state='closed' THEN RETURN NEW; END IF;
  IF cs IS DISTINCT FROM 'accepted'
     OR NOT EXISTS (SELECT 1 FROM iam.accounts aa WHERE aa.id=ca AND aa.state='enabled')
     OR NOT EXISTS (SELECT 1 FROM iam.accounts ab WHERE ab.id=cb AND ab.state='enabled')
     OR EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND ((bl.blocker_account_id=ca AND bl.blocked_account_id=cb) OR (bl.blocker_account_id=cb AND bl.blocked_account_id=ca)))
  THEN RAISE EXCEPTION 'conversation connection binding is invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION messaging.message_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a uuid; b uuid;
BEGIN
  SELECT m.account_a,m.account_b INTO a,b
    FROM messaging.conversations m
    JOIN connection.connections c ON c.id=m.connection_id AND c.version=m.connection_epoch AND c.mode=m.mode AND c.state='accepted'
    JOIN iam.accounts aa ON aa.id=c.account_a AND aa.state='enabled'
    JOIN iam.accounts ab ON ab.id=c.account_b AND ab.state='enabled'
   WHERE m.id=NEW.conversation_id AND m.state='active'
     AND NOT EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND ((bl.blocker_account_id=m.account_a AND bl.blocked_account_id=m.account_b) OR (bl.blocker_account_id=m.account_b AND bl.blocked_account_id=m.account_a)));
  IF a IS NULL OR (NEW.sender_id IS DISTINCT FROM a AND NEW.sender_id IS DISTINCT FROM b) THEN RAISE EXCEPTION 'message connection binding is invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION messaging.outbox_participant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a uuid; b uuid; message_conversation uuid; sender uuid;
BEGIN
  SELECT m.account_a,m.account_b INTO a,b
    FROM messaging.conversations m JOIN connection.connections c ON c.id=m.connection_id AND c.version=m.connection_epoch AND c.mode=m.mode AND c.state='accepted'
    JOIN iam.accounts aa ON aa.id=c.account_a AND aa.state='enabled'
    JOIN iam.accounts ab ON ab.id=c.account_b AND ab.state='enabled'
   WHERE m.id=NEW.conversation_id AND m.state='active'
     AND NOT EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND ((bl.blocker_account_id=m.account_a AND bl.blocked_account_id=m.account_b) OR (bl.blocker_account_id=m.account_b AND bl.blocked_account_id=m.account_a)));
  SELECT conversation_id,sender_id INTO message_conversation,sender FROM messaging.messages WHERE id=NEW.message_id;
  IF a IS NULL OR message_conversation IS DISTINCT FROM NEW.conversation_id OR NEW.recipient_id=sender OR (NEW.recipient_id IS DISTINCT FROM a AND NEW.recipient_id IS DISTINCT FROM b) THEN RAISE EXCEPTION 'outbox recipient/message binding is invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION messaging.receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sender uuid; a uuid; b uuid; current_state text; current_version integer; conversation_epoch integer; current_mode text; conversation_mode text;
BEGIN
  SELECT sender_id INTO sender FROM messaging.messages WHERE id=NEW.message_id;
  SELECT c.account_a,c.account_b,c.state,c.version,c.mode,m.connection_epoch,m.mode INTO a,b,current_state,current_version,current_mode,conversation_epoch,conversation_mode
    FROM messaging.messages msg JOIN messaging.conversations m ON m.id=msg.conversation_id JOIN connection.connections c ON c.id=m.connection_id
   WHERE msg.id=NEW.message_id AND m.state='active';
  IF sender IS NULL OR NEW.viewer_id=sender OR (NEW.viewer_id IS DISTINCT FROM a AND NEW.viewer_id IS DISTINCT FROM b)
     OR current_state IS DISTINCT FROM 'accepted' OR current_version IS DISTINCT FROM conversation_epoch OR current_mode IS DISTINCT FROM conversation_mode
     OR NOT EXISTS (SELECT 1 FROM iam.accounts aa WHERE aa.id=a AND aa.state='enabled')
     OR NOT EXISTS (SELECT 1 FROM iam.accounts ab WHERE ab.id=b AND ab.state='enabled')
     OR EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND ((bl.blocker_account_id=a AND bl.blocked_account_id=b) OR (bl.blocker_account_id=b AND bl.blocked_account_id=a)))
  THEN RAISE EXCEPTION 'receipt connection binding is invalid'; END IF;
  IF TG_OP='UPDATE' AND ((OLD.delivered_at IS NOT NULL AND (NEW.delivered_at IS NULL OR NEW.delivered_at < OLD.delivered_at)) OR (OLD.read_at IS NOT NULL AND (NEW.read_at IS NULL OR NEW.read_at < OLD.read_at))) THEN RAISE EXCEPTION 'receipt is not monotonic'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION messaging.outbox_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text; current_version integer; current_epoch integer; current_mode text; conversation_mode text; account_a uuid; account_b uuid;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.payload_json IS DISTINCT FROM OLD.payload_json OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'outbox identity is immutable'; END IF;
  IF OLD.state='pending' AND NEW.state='pending' THEN
    IF NEW.attempts < OLD.attempts OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.dispatched_at IS NOT NULL OR (OLD.lease_until IS NOT NULL AND OLD.lease_until > now() AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner) OR (NEW.lease_owner IS NULL AND NEW.lease_until IS NOT NULL) OR (NEW.lease_owner IS NOT NULL AND NEW.lease_until IS NULL) THEN RAISE EXCEPTION 'outbox lease transition is invalid'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'pending' OR NEW.state NOT IN ('dispatched','cancelled') THEN RAISE EXCEPTION 'outbox transition is invalid'; END IF;
  IF NEW.state='dispatched' THEN
    SELECT c.state,c.version,c.mode,m.connection_epoch,m.mode,m.account_a,m.account_b INTO current_state,current_version,current_mode,current_epoch,conversation_mode,account_a,account_b
      FROM messaging.conversations m JOIN connection.connections c ON c.id=m.connection_id
      JOIN iam.accounts aa ON aa.id=c.account_a AND aa.state='enabled'
      JOIN iam.accounts ab ON ab.id=c.account_b AND ab.state='enabled'
     WHERE m.id=NEW.conversation_id AND m.state='active';
    IF current_state IS DISTINCT FROM 'accepted' OR current_version IS DISTINCT FROM current_epoch OR current_mode IS DISTINCT FROM conversation_mode
       OR EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND ((bl.blocker_account_id=account_a AND bl.blocked_account_id=account_b) OR (bl.blocker_account_id=account_b AND bl.blocked_account_id=account_a)))
    THEN RAISE EXCEPTION 'outbox connection binding is no longer current'; END IF;
  END IF;
  IF NEW.state='dispatched' AND NEW.dispatched_at IS NULL THEN RAISE EXCEPTION 'dispatch timestamp required'; END IF;
  IF NEW.state='cancelled' AND NEW.dispatched_at IS NOT NULL THEN RAISE EXCEPTION 'cancelled outbox cannot be dispatched'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION messaging.outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload_json <> jsonb_build_object('conversation_id', NEW.conversation_id::text, 'message_id', NEW.message_id::text, 'event', 'message.wake') THEN RAISE EXCEPTION 'opaque outbox only'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER message_guard BEFORE UPDATE ON messaging.messages FOR EACH ROW EXECUTE FUNCTION messaging.message_guard();
CREATE TRIGGER conversation_guard BEFORE INSERT OR UPDATE ON messaging.conversations FOR EACH ROW EXECUTE FUNCTION messaging.conversation_guard();
CREATE TRIGGER message_insert_guard BEFORE INSERT ON messaging.messages FOR EACH ROW EXECUTE FUNCTION messaging.message_insert_guard();
CREATE TRIGGER ai_draft_guard BEFORE UPDATE ON messaging.ai_drafts FOR EACH ROW EXECUTE FUNCTION messaging.draft_guard();
CREATE TRIGGER ai_draft_append_only BEFORE DELETE ON messaging.ai_drafts FOR EACH ROW EXECUTE FUNCTION messaging.append_only();
CREATE TRIGGER outbox_guard BEFORE INSERT OR UPDATE ON messaging.notification_outbox FOR EACH ROW EXECUTE FUNCTION messaging.outbox_guard();
CREATE TRIGGER outbox_participant_guard BEFORE INSERT ON messaging.notification_outbox FOR EACH ROW EXECUTE FUNCTION messaging.outbox_participant_guard();
CREATE TRIGGER receipt_guard BEFORE INSERT OR UPDATE ON messaging.receipts FOR EACH ROW EXECUTE FUNCTION messaging.receipt_guard();
CREATE TRIGGER outbox_transition_guard BEFORE UPDATE ON messaging.notification_outbox FOR EACH ROW EXECUTE FUNCTION messaging.outbox_transition_guard();
-- +END UP
-- +BEGIN DOWN
DROP TRIGGER IF EXISTS outbox_guard ON messaging.notification_outbox;
DROP TRIGGER IF EXISTS outbox_participant_guard ON messaging.notification_outbox;
DROP TRIGGER IF EXISTS receipt_guard ON messaging.receipts;
DROP TRIGGER IF EXISTS outbox_transition_guard ON messaging.notification_outbox;
DROP TRIGGER IF EXISTS ai_draft_append_only ON messaging.ai_drafts;
DROP TRIGGER IF EXISTS ai_draft_guard ON messaging.ai_drafts;
DROP TRIGGER IF EXISTS message_guard ON messaging.messages;
DROP TRIGGER IF EXISTS conversation_guard ON messaging.conversations;
DROP TRIGGER IF EXISTS message_insert_guard ON messaging.messages;
DROP FUNCTION IF EXISTS messaging.outbox_guard();
DROP FUNCTION IF EXISTS messaging.message_guard();
DROP FUNCTION IF EXISTS messaging.conversation_guard();
DROP FUNCTION IF EXISTS messaging.message_insert_guard();
DROP FUNCTION IF EXISTS messaging.outbox_participant_guard();
DROP FUNCTION IF EXISTS messaging.receipt_guard();
DROP FUNCTION IF EXISTS messaging.outbox_transition_guard();
DROP FUNCTION IF EXISTS messaging.draft_guard();
DROP FUNCTION IF EXISTS messaging.append_only();
DROP TABLE IF EXISTS messaging.ai_drafts;
DROP TABLE IF EXISTS messaging.notification_outbox;
DROP TABLE IF EXISTS messaging.receipts;
DROP TABLE IF EXISTS messaging.messages;
DROP TABLE IF EXISTS messaging.conversations;
DROP SCHEMA IF EXISTS messaging;
-- +END DOWN
