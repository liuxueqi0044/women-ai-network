-- IAM-01 base schema: accounts, credentials, sessions, devices, MFA,
-- recovery codes, audit and security events.
--
-- The runner (src/migrate.ts) applies the UP section forward and the DOWN
-- section backward, tracking applied files + checksums in
-- iam.schema_migrations. drizzle-kit is reference-only and never runs.
--
-- PII discipline: email exists only as HMAC digest (lookup) + AES-256-GCM
-- ciphertext (storage); session/device/challenge tokens and recovery codes
-- are stored exclusively as keyed digests; TOTP secrets are stored
-- encrypted. No plaintext email, token, code, full IP or raw User-Agent
-- is ever written here.

-- +BEGIN UP

CREATE SCHEMA IF NOT EXISTS iam;

CREATE TABLE iam.accounts (
    id uuid PRIMARY KEY,
    email_digest text,
    email_ciphertext text NOT NULL,
    email_nonce text NOT NULL,
    email_key_id text NOT NULL,
    state text NOT NULL,
    state_reason text NOT NULL,
    state_actor_type text NOT NULL,
    state_actor_id uuid,
    state_changed_at timestamptz NOT NULL,
    version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    CONSTRAINT accounts_state_chk CHECK (state IN ('enabled', 'suspended', 'deletion_pending', 'deleted')),
    CONSTRAINT accounts_state_reason_chk CHECK (
        (state = 'enabled' AND state_reason IN ('registered', 'admin_unsuspend', 'user_deletion_cancel'))
        OR (state = 'suspended' AND state_reason = 'admin_suspend')
        OR (state = 'deletion_pending' AND state_reason = 'user_deletion_request')
        OR (state = 'deleted' AND state_reason = 'deletion_completed')
    ),
    CONSTRAINT accounts_actor_type_chk CHECK (state_actor_type IN ('system', 'admin', 'user')),
    CONSTRAINT accounts_digest_presence_chk CHECK (
        (deleted_at IS NULL AND email_digest IS NOT NULL)
        OR (deleted_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX accounts_email_digest_idx ON iam.accounts (email_digest)
    WHERE email_digest IS NOT NULL;

CREATE TABLE iam.password_credentials (
    account_id uuid PRIMARY KEY REFERENCES iam.accounts (id) ON DELETE CASCADE,
    hash text NOT NULL,
    hash_version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT password_credentials_hash_chk CHECK (hash LIKE '$argon2%')
);

CREATE TABLE iam.devices (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
    device_digest text NOT NULL,
    label text NOT NULL,
    ua_digest text NOT NULL,
    ua_summary text,
    ip_hmac text NOT NULL,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT devices_label_chk CHECK (char_length(label) BETWEEN 1 AND 64),
    CONSTRAINT devices_label_no_crlf_chk CHECK (label NOT LIKE E'%\r%' AND label NOT LIKE E'%\n%')
);

CREATE UNIQUE INDEX devices_account_digest_idx ON iam.devices (account_id, device_digest);

CREATE TABLE iam.sessions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
    device_id uuid REFERENCES iam.devices (id) ON DELETE SET NULL,
    family_id uuid NOT NULL,
    parent_id uuid,
    successor_id uuid,
    token_digest text NOT NULL,
    generation integer NOT NULL DEFAULT 1,
    state text NOT NULL,
    auth_level text NOT NULL,
    created_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    rotated_at timestamptz,
    revoked_at timestamptz,
    revoked_reason text,
    CONSTRAINT sessions_state_chk CHECK (state IN ('active', 'rotated', 'revoked', 'compromised')),
    CONSTRAINT sessions_auth_level_chk CHECK (auth_level IN ('aal1', 'aal2')),
    CONSTRAINT sessions_generation_chk CHECK (generation >= 1),
    CONSTRAINT sessions_expiry_order_chk CHECK (
        created_at <= last_seen_at
        AND last_seen_at <= idle_expires_at
        AND idle_expires_at <= absolute_expires_at
    ),
    CONSTRAINT sessions_successor_self_chk CHECK (successor_id IS NULL OR successor_id <> id),
    CONSTRAINT sessions_parent_self_chk CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX sessions_token_digest_idx ON iam.sessions (token_digest);
CREATE INDEX sessions_account_state_idx ON iam.sessions (account_id, state);
CREATE INDEX sessions_family_idx ON iam.sessions (family_id);

CREATE TABLE iam.mfa_factors (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
    type text NOT NULL,
    state text NOT NULL,
    secret_ciphertext text NOT NULL,
    secret_nonce text NOT NULL,
    secret_key_id text NOT NULL,
    created_at timestamptz NOT NULL,
    verified_at timestamptz,
    enabled_at timestamptz,
    disabled_at timestamptz,
    CONSTRAINT mfa_factors_type_chk CHECK (type = 'totp'),
    CONSTRAINT mfa_factors_state_chk CHECK (state IN ('pending', 'enabled', 'disabled'))
);

CREATE INDEX mfa_factors_account_idx ON iam.mfa_factors (account_id);

CREATE TABLE iam.mfa_challenges (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
    digest text NOT NULL,
    state text NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL,
    CONSTRAINT mfa_challenges_state_chk CHECK (state IN ('pending', 'consumed', 'expired', 'revoked')),
    CONSTRAINT mfa_challenges_attempts_chk CHECK (attempt_count BETWEEN 0 AND max_attempts)
);

CREATE UNIQUE INDEX mfa_challenges_digest_idx ON iam.mfa_challenges (digest);

CREATE TABLE iam.recovery_codes (
    id uuid PRIMARY KEY,
    factor_id uuid NOT NULL REFERENCES iam.mfa_factors (id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
    code_digest text NOT NULL,
    created_at timestamptz NOT NULL,
    used_at timestamptz
);

CREATE UNIQUE INDEX recovery_codes_digest_idx ON iam.recovery_codes (code_digest);

CREATE TABLE iam.account_state_transitions (
    id bigserial PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES iam.accounts (id) ON DELETE CASCADE,
    from_state text NOT NULL,
    to_state text NOT NULL,
    reason text NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    version integer NOT NULL,
    created_at timestamptz NOT NULL
);

CREATE INDEX account_state_transitions_account_idx ON iam.account_state_transitions (account_id);

CREATE TABLE iam.security_events (
    id bigserial PRIMARY KEY,
    event_type text NOT NULL,
    account_id uuid,
    session_id uuid,
    device_id uuid,
    severity text NOT NULL,
    reason text NOT NULL,
    ip_hmac text,
    created_at timestamptz NOT NULL,
    CONSTRAINT security_events_severity_chk CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX security_events_account_idx ON iam.security_events (account_id);
CREATE INDEX security_events_type_idx ON iam.security_events (event_type, created_at);

-- +END UP

-- +BEGIN DOWN

DROP SCHEMA IF EXISTS iam CASCADE;

-- +END DOWN
