-- CON-01: PostgreSQL-authoritative explicit two-party connections.
-- The pair is canonicalized by account_a/account_b; historical blocks are
-- terminal invalidations and never revive an accepted graph edge.

-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS connection;

CREATE TABLE connection.connections (
  id uuid PRIMARY KEY,
  account_a uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  account_b uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  requester_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  recipient_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('friends','activities','professional','circles','events','dating')),
  state text NOT NULL CHECK (state IN ('pending','accepted','declined','cancelled','disconnected','invalidated')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  accepted_at timestamptz,
  disconnected_at timestamptz,
  invalidated_at timestamptz,
  cooldown_until timestamptz,
  CONSTRAINT connections_pair_order_chk CHECK (account_a < account_b),
  CONSTRAINT connections_endpoints_chk CHECK (
    (requester_account_id = account_a AND recipient_account_id = account_b)
    OR (requester_account_id = account_b AND recipient_account_id = account_a)
  ),
  CONSTRAINT connections_state_dates_chk CHECK (
    (state IN ('accepted','disconnected') AND accepted_at IS NOT NULL)
    OR (state IN ('pending','declined','cancelled') AND accepted_at IS NULL)
    OR state = 'invalidated'
  ),
  CONSTRAINT connections_terminal_dates_chk CHECK (
    (state = 'disconnected' AND disconnected_at IS NOT NULL)
    OR (state <> 'disconnected' AND disconnected_at IS NULL)
  ),
  CONSTRAINT connections_invalidated_dates_chk CHECK (
    (state = 'invalidated' AND invalidated_at IS NOT NULL)
    OR (state <> 'invalidated' AND invalidated_at IS NULL)
  ),
  UNIQUE (id)
);
CREATE UNIQUE INDEX connection_active_pair_unique
  ON connection.connections(account_a, account_b)
  WHERE state IN ('pending','accepted');
CREATE INDEX connection_actor_state_idx ON connection.connections(account_a, state, updated_at DESC);
CREATE INDEX connection_subject_state_idx ON connection.connections(account_b, state, updated_at DESC);

CREATE TABLE connection.idempotency_keys (
  actor_account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('create','accept','decline','cancel','disconnect')),
  idempotency_digest text NOT NULL CHECK (idempotency_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  connection_id uuid NOT NULL REFERENCES connection.connections(id) ON DELETE CASCADE,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_account_id, operation, idempotency_digest)
);

CREATE TABLE connection.transitions (
  id bigserial PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connection.connections(id) ON DELETE CASCADE,
  actor_account_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  from_state text,
  to_state text NOT NULL CHECK (to_state IN ('pending','accepted','declined','cancelled','disconnected','invalidated')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX connection_transitions_connection_idx ON connection.transitions(connection_id, created_at);

CREATE OR REPLACE FUNCTION connection.transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_a <> OLD.account_a OR NEW.account_b <> OLD.account_b
     OR NEW.requester_account_id <> OLD.requester_account_id
     OR NEW.recipient_account_id <> OLD.recipient_account_id
     OR NEW.mode <> OLD.mode
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'connection identity is immutable';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'pending' AND NEW.state IN ('accepted','declined','cancelled','invalidated'))
      OR (OLD.state = 'accepted' AND NEW.state IN ('disconnected','invalidated'))) THEN
      RAISE EXCEPTION 'invalid connection state transition';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'connection version must advance exactly once';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'connection version cannot change without a state transition';
  END IF;
  IF NEW.state = 'accepted' AND OLD.state <> 'accepted' THEN
    NEW.accepted_at = COALESCE(NEW.accepted_at, now());
  END IF;
  IF NEW.state = 'disconnected' AND OLD.state <> 'disconnected' THEN
    NEW.disconnected_at = COALESCE(NEW.disconnected_at, now());
  END IF;
  IF NEW.state = 'invalidated' AND OLD.state <> 'invalidated' THEN
    NEW.invalidated_at = COALESCE(NEW.invalidated_at, now());
  END IF;
  NEW.updated_at = now();
  IF NEW.state IN ('declined','cancelled','disconnected','invalidated') AND OLD.state <> NEW.state THEN
    NEW.cooldown_until = now() + interval '7 days';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_transition_guard
  BEFORE UPDATE ON connection.connections
  FOR EACH ROW EXECUTE FUNCTION connection.transition_guard();

CREATE OR REPLACE FUNCTION connection.append_block_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data record;
BEGIN
  FOR row_data IN
    SELECT c.id, c.state, c.version
      FROM connection.connections c
     WHERE c.state IN ('pending','accepted')
       AND (c.accepted_at IS NULL OR c.accepted_at <= NEW.created_at)
       AND ((c.account_a = NEW.blocker_account_id AND c.account_b = NEW.blocked_account_id)
         OR (c.account_a = NEW.blocked_account_id AND c.account_b = NEW.blocker_account_id))
     FOR UPDATE
  LOOP
    UPDATE connection.connections
       SET state = 'invalidated', version = version + 1, invalidated_at = NEW.created_at,
           updated_at = NEW.created_at
     WHERE id = row_data.id;
    INSERT INTO connection.transitions
      (connection_id, actor_account_id, from_state, to_state, reason, created_at)
    VALUES (row_data.id, NEW.blocker_account_id, row_data.state, 'invalidated', 'safety_block', NEW.created_at);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_block_invalidation
  AFTER INSERT ON safety.blocks
  FOR EACH ROW WHEN (NEW.state = 'active')
  EXECUTE FUNCTION connection.append_block_invalidation();

CREATE OR REPLACE FUNCTION connection.append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Account erasure reaches this table through the ON DELETE CASCADE chain.
  -- Only that nested FK cascade may remove history; direct mutation remains
  -- forbidden and the history is otherwise append-only.
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'connection transition history is append-only';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER connection_transitions_append_only
  BEFORE UPDATE OR DELETE ON connection.transitions
  FOR EACH ROW EXECUTE FUNCTION connection.append_only_guard();

-- +END UP

-- +BEGIN DOWN
DROP TRIGGER IF EXISTS connection_block_invalidation ON safety.blocks;
DROP FUNCTION IF EXISTS connection.append_block_invalidation();
DROP TRIGGER IF EXISTS connection_transitions_append_only ON connection.transitions;
DROP FUNCTION IF EXISTS connection.append_only_guard();
DROP TRIGGER IF EXISTS connection_transition_guard ON connection.connections;
DROP FUNCTION IF EXISTS connection.transition_guard();
DROP TABLE IF EXISTS connection.idempotency_keys;
DROP TABLE IF EXISTS connection.transitions;
DROP TABLE IF EXISTS connection.connections;
DROP SCHEMA IF EXISTS connection CASCADE;
-- +END DOWN
