-- GLO-01: account-bound UI locale, content locales and display authority.
-- +BEGIN UP
CREATE SCHEMA IF NOT EXISTS globalization;
CREATE TABLE globalization.account_preferences (
  account_id uuid PRIMARY KEY REFERENCES iam.accounts(id) ON DELETE CASCADE,
  ui_locale text NOT NULL CHECK (ui_locale IN ('en', 'zh-Hans-CN', 'es-419', 'fr')),
  content_locales text[] NOT NULL CHECK (cardinality(content_locales) BETWEEN 0 AND 8),
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
  hour_cycle text NOT NULL CHECK (hour_cycle IN ('h11', 'h12', 'h23', 'h24')),
  week_start smallint NOT NULL CHECK (week_start BETWEEN 0 AND 6),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE globalization.preference_idempotency (
  account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  idempotency_key_digest text NOT NULL CHECK (idempotency_key_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, idempotency_key_digest)
);
CREATE TABLE globalization.preference_audit (
  id bigserial PRIMARY KEY, account_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 0), ui_locale_old text, ui_locale_new text NOT NULL,
  content_locales_old_hash text, content_locales_new_hash text NOT NULL,
  time_zone_old_hash text, time_zone_new_hash text NOT NULL, hour_cycle_old text,
  hour_cycle_new text NOT NULL, week_start_old smallint, week_start_new smallint NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX globalization_preference_audit_account_idx ON globalization.preference_audit(account_id, id);
CREATE OR REPLACE FUNCTION globalization.validate_time_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN RAISE EXCEPTION 'invalid PostgreSQL time zone'; END IF;
  IF NEW.content_locales IS NULL OR cardinality(NEW.content_locales) <> cardinality(ARRAY(SELECT DISTINCT unnest(NEW.content_locales))) THEN RAISE EXCEPTION 'content locales must be unique'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER account_preferences_timezone_guard BEFORE INSERT OR UPDATE ON globalization.account_preferences FOR EACH ROW EXECUTE FUNCTION globalization.validate_time_zone();
CREATE OR REPLACE FUNCTION globalization.audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A parent-account DELETE cascades into this table while the parent row is
  -- no longer visible. Permit only that FK cleanup path; direct mutation of a
  -- still-owned audit row remains rejected.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM iam.accounts WHERE id = OLD.account_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'globalization audit is append-only';
END; $$;
CREATE TRIGGER preference_audit_append_only BEFORE UPDATE OR DELETE ON globalization.preference_audit FOR EACH ROW EXECUTE FUNCTION globalization.audit_append_only();
-- +END UP
-- +BEGIN DOWN
DROP TRIGGER IF EXISTS preference_audit_append_only ON globalization.preference_audit;
DROP TRIGGER IF EXISTS account_preferences_timezone_guard ON globalization.account_preferences;
DROP FUNCTION IF EXISTS globalization.audit_append_only();
DROP FUNCTION IF EXISTS globalization.validate_time_zone();
DROP TABLE IF EXISTS globalization.preference_audit;
DROP TABLE IF EXISTS globalization.preference_idempotency;
DROP TABLE IF EXISTS globalization.account_preferences;
DROP SCHEMA IF EXISTS globalization;
-- +END DOWN
