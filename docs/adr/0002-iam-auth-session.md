# ADR 0002 — IAM-01 Account Authentication & Session Protocol

- Status: accepted
- Date: 2026-08-16
- Deciders: IAM-01 implementation engineer (Claude Code, user-configured
  DeepSeek model)
- Scope: account registration, password login, opaque sessions, TOTP MFA,
  recovery codes, devices, and rate limiting — API only, no UI

## Context

The Women AI Network needs a first-party account system with password
login and MFA before any member-facing feature can exist. IAM-01 must
ship: registration (email + password), password login, an opaque session
protocol with rotation and replay detection, TOTP MFA with recovery
codes, device management, and layered rate limiting — all behind the
FND-01 foundation (Fastify/NestJS API, Postgres, Valkey, Zod contracts,
redacting observability) without breaking any of its invariants.

The task book (docs/tasks/IAM-01.md) fixes the design: it explicitly
forbids Better Auth, Auth.js, Passport sessions, JWT-in-localStorage and
hand-rolled password/TOTP algorithms, and pins the exact libraries and
OWASP Argon2 parameters.

## Decisions

### D1. Port/adapter auth core — the task-book design is the architecture

`apps/api/src/account/ports.ts` defines every boundary the domain code
may touch: password hashing + TOTP (`AuthProvider`), secret cipher
(`SecretCipher`), keyed digester (`TokenDigester`), rate limiter, clock,
and CSPRNG. Production wiring in `account.module.ts` binds
`Argon2AuthProvider` (@node-rs/argon2 + otpauth), `NodeSecretCipher`
(AES-256-GCM), `NodeTokenDigester` (HMAC-SHA-256) and the Valkey rate
limiter; unit tests bind deterministic fakes. The same compliance suite
(`auth-provider/compliance.spec.ts`) runs against both so the real
provider is never validated by itself. No third-party auth framework is
used; the task book names the alternatives and rejects them.

### D2. Opaque session tokens; only keyed digests reach the database

Sessions are 256-bit CSPRNG tokens (`randomBytes(32)`, base64url, 43
chars) delivered only as HttpOnly cookies. The database stores only
`HMAC-SHA-256(secretPepper, "session" + token)` digests, so a database
read does not yield a usable token and token equality is never compared
in SQL. Each account/session row also carries `family_id` and
`generation`: rotation extends the family with a child row; every member
of the family derives from the same original token.

### D3. Rotation is atomic and replay burns the whole family; logout revokes

Every auth-level change (MFA enable/disable, password change in later
modules) rotates: in ONE transaction the current session row is locked
`FOR UPDATE`, marked `rotated`, a successor row (with a fresh token
digest) is inserted, and the successor token is set on the cookie only
after the transaction committed. If a `rotated` token is ever presented
again, the whole family is marked `compromised` and every family member
is rejected with `SESSION_REPLAY_DETECTED` — the replay of one old token
cannot survive the rotation of the successor (the "no session fixation /
no token reuse" property the task book's acceptance matrix demands).
Concurrent rotations of the same session: the loser finds the row
`rotated` under the lock and triggers the replay path.

Logout does NOT rotate: `DELETE /v1/account/session` revokes the
caller's own session server-side (`state = 'revoked'`, reason `LOGOUT`)
and clears the cookie — no successor row is inserted, so logout never
triggers replay semantics. Revoking another session via the sessions
list (`DELETE /v1/account/sessions/:id`) is the same revoke with reason
`REVOKED_BY_USER`. MFA disable is a rotation with `revokeOthers`: every
other active session of the account is revoked and the strength change
is audited (`mfa_strength_change`).

### D4. Server clock governs lifetimes; absolute expiry never extends

Session lifetimes are computed from the server clock at issue time and
re-validated on every request against the stored row: idle expiry (7
days default) is refreshed on activity, absolute expiry (30 days
default) is inherited by every successor and never extended — a
client-controlled clock or cookie manipulation cannot prolong a session.
Idle is capped at the absolute expiry (`idle_expires_at =
min(now + idleSeconds, absolute_expires_at)`) on issue, touch and
rotation alike, so a misconfigured idle window longer than the remaining
absolute lifetime can never violate the DB `sessions_expiry_order_chk`
constraint or extend the absolute limit. Activity means any authenticated
request: the `SessionAuthGuard` touches the row before the route runs,
so idle is refreshed by API use, not just by an explicit session
endpoint. The guard re-checks the account state on every request, so a
suspended/deletion-pending/deleted account loses both new logins and
existing sessions. The activity update is conditional on the session still
being active and unexpired. If it affects no row, the guard re-reads the row:
a concurrent rotation keeps the stronger replay/family-compromise behavior,
while concurrent revocation or expiry fails with `SESSION_REQUIRED`; the stale
snapshot is never authorized.

### D5. Argon2id with the task-book-pinned OWASP parameters

`@node-rs/argon2@2.1.0` with `memoryCost: 19_456` KiB (19 MiB),
`timeCost: 2`, `parallelism: 1`, 32-byte output — the OWASP minimum
parameter set, as pinned by the task book. The compliance suite asserts
the `$argon2id$v=19$m=19456,t=2,p=1` prefix so a future parameter
regression fails loudly. Unknown-email logins run a dummy verify against
a fixed valid hash so timing cannot distinguish "no account" from
"wrong password"; every anonymous failure answers the same envelope
(`401 INVALID_CREDENTIALS`) with the real reason only in internal audit
events.

### D6. PII is never stored or logged in plaintext

Email is stored as a keyed digest (for lookups and rate limiting) plus
AES-256-GCM ciphertext with an explicit `key_id`, so the key set can be
rotated without touching rows. MFA secrets, recovery codes, session
tokens and cookies exist only as digests or ciphertext in the database
and never reach logs, errors or responses. Logs and security events
carry only HMAC'd IPs (`ipHmac`), coarse UA summaries and keyed UA
digests. The FND-01 redactor (key-based + content backstop) stays on and
is never weakened.

### D7. HttpOnly cookie policy with a `__Host-` production name

Production sessions use `__Host-wai_session` (browsers reject the cookie
unless Secure, Path=/ and no Domain are set); dev/test use
`wai_session_dev` without Secure so http://localhost works. All three
cookies — session, MFA challenge (`wai_mfa_challenge`, Path scoped to
`/v1/account/sessions`, 300 s) and device (`wai_device`, 365 d) — are
HttpOnly + SameSite=Lax, and every mutating IAM route is additionally
guarded by an Origin check (requests without an Origin header — CLI,
curl — pass). MFA challenge tokens are single-use: consumed on success,
burned on account-state denial, and capped at 5 wrong-code attempts
before they expire. The cap is applied by an atomic conditional UPDATE,
so concurrent misses can never push `attempt_count` past the maximum and
can never surface a 500 (R1-05).

### D8. Layered rate limiting on IP and email-digest

Two dimensions, both against Valkey: per-IP windows (registration 30,
login 60, MFA attempts 30 per 900 s window) and per-email-digest windows
(registration 3, login 10 per 900 s window). Limits are keyed on digests
and the failure envelope is the same `429 RATE_LIMITED` shape as
`400 VALIDATION_ERROR`/`401 INVALID_CREDENTIALS` so endpoints stay
enumeration-resistant. Dev defaults are intentionally tighter than the
prod defaults to catch throttling bugs early.

### D9. At most one active TOTP factor per account (partial unique index)

Enrollment is single-slot: a partial unique index
`mfa_factors_active_unique_idx ON iam.mfa_factors (account_id) WHERE
state IN ('pending', 'enabled')` makes it impossible to hold two
pending or enabled factors, even under concurrent enrollment starts —
the loser's insert hits the index violation and answers
`409 MFA_ENROLLMENT_IN_PROGRESS` / `MFA_ALREADY_ENABLED`. `disabled`
factors do not occupy the slot, so disabling frees it for
re-enrollment. The pre-release `0002` upgrade is fail-safe for data created by
the old race: one enabled factor is always preserved over pending rows; with no
enabled factor, one deterministic pending row is retained. Multiple enabled
factors are ambiguous security credentials, so the migration aborts without
deleting anything and requires explicit operator remediation. A unique-index
violation is mapped without querying again inside the PostgreSQL transaction,
which is already aborted after `23505`.

### D10. MFA challenges bind to the device and carry a method set

A challenge is created with the device the password step happened on
(`mfa_challenges.device_id`) and the methods that may complete it
(`method_set`: `['totp']`, or `['totp','recovery']` when unused recovery
codes exist). The completion step verifies the presented device cookie
against the stored device before any code is consumed — a challenge
replayed from another device answers `401 MFA_INVALID` (audit
`MFA_DEVICE_MISMATCH`) without burning an attempt. A CHECK constraint
keeps `method_set` non-empty and within `['totp','recovery']`; another CHECK
requires `device_id` on every pending challenge. During a 0001 → 0002 upgrade,
all legacy pending challenges are expired before the constraint is installed,
so deployment never creates a temporary unbound-redemption window. Historical
terminal rows may retain a NULL device for audit compatibility, but application
code also fails closed if an unbound pending row is ever observed. Device hard
deletion cascades to its challenges, avoiding a `SET NULL` transition that would
violate the pending-device invariant; the public device-revoke API remains a
soft revoke and does not delete the row.

### D11. Devices persist only an HMAC of the IP prefix, never the IP

Per the task book's data-minimization rule, a device row stores
`ip_hmac = HMAC(secretPepper, "device-ip", prefix)` where `prefix` is
the IPv4 `/24` or the IPv6 `/64` of the connecting address;
IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is normalized back to IPv4 before
truncation. `ipaddr.js@2.2.0` (MIT, pure JS, pinned) performs the
RFC 4291 parsing; unparseable input maps to a stable sentinel digest so
nothing derived from a malformed address is persisted. The full client
IP is never stored or logged anywhere.

### D12. Account-state transitions carry the request id

The append-only `iam.account_state_transitions` audit is stamped with
the request id of the mutation that caused the transition
(`request_id`, from the validated client `x-request-id` or the
server-generated id) — including the initial `registered → enabled`
row created at registration. The id is an internal audit field: it is
never returned in API responses.

### D13. Explicit non-goals (task book §15)

Password reset, email verification, social login, passkey, trusted-device
MFA bypass, JWT access/refresh tokens, OAuth/OIDC server, admin
banning APIs, and the Web UI for register/login/MFA are all out of
scope and must not be added by this module.

## Consequences

- Every future auth feature (password change, reset, verification)
  reuses the rotation/replay machinery: rotate with `revokeOthers` and
  set the new cookie only after commit.
- The digest/cipher boundary means any new PII field needs the same
  treatment (digest + AES-GCM + key_id) before it can land in `iam.*`.
- Locked dependency versions are part of the security posture: upgrading
  argon2/otpauth requires re-running the compliance suite, and any
  change to the hash parameters must be a deliberate, documented act.
- Session semantics are not a JWT: there is no client-verifiable state,
  and anything that needs "who am I" state must call the API.
