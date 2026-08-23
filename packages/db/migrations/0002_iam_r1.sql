-- R1-04 single active TOTP factor invariant + R1-06 challenge device/method
-- binding and transition request correlation. Delivered as ONE migration per
-- the R1 plan (no 0002a/0002b split); the repository/schema layers sync with
-- the code of each checkpoint.

-- +BEGIN UP
-- R1-04/R2-01 fail-safe data repair. 0001 allowed duplicate active factors.
-- Never choose between two ENABLED credentials: an arbitrary choice could
-- invalidate the authenticator the member actually controls. Abort the whole
-- transaction and preserve every row for explicit operator remediation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM iam.mfa_factors
    WHERE state = 'enabled'
    GROUP BY account_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'IAM migration blocked: account has multiple enabled MFA factors'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- A verified factor always wins over unfinished enrollment rows. This is the
-- security-critical ordering: deleting enabled in favour of an older pending
-- row would silently downgrade the account to password-only authentication.
DELETE FROM iam.mfa_factors pending
WHERE pending.state = 'pending'
  AND EXISTS (
    SELECT 1
    FROM iam.mfa_factors enabled
    WHERE enabled.account_id = pending.account_id
      AND enabled.state = 'enabled'
  );

-- When there is no enabled factor, retain one deterministic pending enrollment
-- and discard only the duplicate unfinished rows.
DELETE FROM iam.mfa_factors pending
WHERE pending.state = 'pending'
  AND pending.id <> (
    SELECT candidate.id
    FROM iam.mfa_factors candidate
    WHERE candidate.account_id = pending.account_id
      AND candidate.state = 'pending'
    ORDER BY candidate.created_at ASC, candidate.id ASC
    LIMIT 1
  );

-- At most one pending OR enabled TOTP factor per account; disabled does not
-- occupy the slot, so a user can re-enroll after disabling.
CREATE UNIQUE INDEX mfa_factors_active_unique_idx
  ON iam.mfa_factors (account_id)
  WHERE state IN ('pending', 'enabled');

-- R1-06A/R2-01: 0001 challenges were not device-bound. Expire every pending
-- legacy challenge before adding the binding; preserving one for its remaining
-- TTL would leave a cross-device redemption window during deployment.
UPDATE iam.mfa_challenges SET state = 'expired' WHERE state = 'pending';

-- Historical terminal rows may remain NULL for audit compatibility. Every new
-- pending challenge must be bound to the password-step device.
ALTER TABLE iam.mfa_challenges
  ADD COLUMN device_id uuid REFERENCES iam.devices (id) ON DELETE CASCADE,
  ADD COLUMN method_set text[] NOT NULL DEFAULT ARRAY['totp', 'recovery'],
  ADD CONSTRAINT mfa_challenges_method_set_chk CHECK (
    cardinality(method_set) > 0
    AND method_set <@ ARRAY['totp', 'recovery']
  ),
  ADD CONSTRAINT mfa_challenges_pending_device_chk CHECK (
    state <> 'pending' OR device_id IS NOT NULL
  );

CREATE INDEX mfa_challenges_account_state_idx ON iam.mfa_challenges (account_id, state);

-- R1-06C: audit correlation — which request produced each state transition.
-- The repository write layer requires a value; NULL only covers 0001-era rows.
ALTER TABLE iam.account_state_transitions ADD COLUMN request_id text;
CREATE INDEX account_state_transitions_request_idx
  ON iam.account_state_transitions (request_id);
-- +END UP

-- +BEGIN DOWN
DROP INDEX IF EXISTS iam.account_state_transitions_request_idx;
ALTER TABLE iam.account_state_transitions DROP COLUMN request_id;
DROP INDEX IF EXISTS iam.mfa_challenges_account_state_idx;
ALTER TABLE iam.mfa_challenges DROP COLUMN method_set;
ALTER TABLE iam.mfa_challenges DROP COLUMN device_id;
DROP INDEX IF EXISTS iam.mfa_factors_active_unique_idx;
-- +END DOWN
