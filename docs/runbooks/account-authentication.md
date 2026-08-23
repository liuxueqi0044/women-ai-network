# Runbook — Account Authentication (IAM-01)

Windows 11 + PowerShell (also works in Git Bash). Every command is
copy-paste ready. This runbook covers the isolated Compose stack, the
`iam.*` migrations, an API smoke test of the account vertical, and the
IAM test suites.

## Prerequisites

| Tool           | Version         | Check                                           |
| -------------- | --------------- | ----------------------------------------------- |
| Node.js        | `>=22.23.2 <23` | `node --version`                                |
| pnpm           | `11.18.0`       | `pnpm --version`                                |
| Docker Desktop | recent          | `docker --version` and `docker compose version` |

Docker Desktop must be **running** (Linux containers).

## Isolated infrastructure (project `wai-iam-01-claude`)

Use a dedicated Compose project with non-default host ports so nothing
collides with the FND-01 stack (5433/6380) or local installs:

```powershell
$env:POSTGRES_HOST_PORT='35433'
$env:VALKEY_HOST_PORT='36380'
docker compose -p wai-iam-01-claude up -d --wait
docker compose -p wai-iam-01-claude ps   # both services must show (healthy)
```

Postgres is reachable on `127.0.0.1:35433` (db `wai_dev`, user `wai_dev`,
password `wai_dev_pg_8f3k`), Valkey on `127.0.0.1:36380`. All containers,
volumes and the network belong to the `wai-iam-01-claude` project;
tearing down only that project removes exactly what this runbook
created:

```powershell
docker compose -p wai-iam-01-claude down -v
```

Isolation check: `docker ps` before and after must differ only by the
`wai-iam-01-claude` project's containers — no container of any other
project (including the user's long-running `napcat`/`astrbot` services)
is ever started, stopped or removed.

## Install and build

```powershell
pnpm install --frozen-lockfile
pnpm build
```

## Migrations

The `iam.*` schema (accounts, sessions, devices, mfa_factors,
recovery_codes, security_events, plus the audit wrapper) is applied with
explicit SQL migrations from `packages/db/migrations`. Today the chain
is `0001_iam_account.sql` → `0002_iam_r1.sql` (R1: challenge
device/method binding, account-state-transition request id, single
active TOTP factor). The `up` command applies every pending version and
is idempotent — the bookkeeping table records applied versions, so a
second run is a safe no-op.

`0002_iam_r1.sql` was corrected before release during the R2 security closeout.
An earlier disposable database that already recorded the pre-closeout checksum
must be recreated; the migration runner deliberately rejects checksum changes
instead of silently accepting altered history. No shared/production database
has received the pre-release migration.

**Upgrade path** (existing 0001 database):

```powershell
$env:DATABASE_URL='postgres://wai_dev:wai_dev_pg_8f3k@127.0.0.1:35433/wai_dev'
pnpm --filter @wai/db exec tsx src/cli/migrate.ts up   # applies 0002 on top of 0001
pnpm --filter @wai/db exec tsx src/cli/migrate.ts up   # second run: must be a no-op
```

Upgrade behavior is deliberately fail-safe:

- a single enabled MFA factor is preserved over any pending duplicates;
- pending-only duplicates retain one deterministic row;
- multiple enabled factors abort the migration without deleting data and must
  be remediated explicitly before retrying;
- legacy pending MFA challenges are expired before device binding becomes
  mandatory.

**Fresh path** (empty database): run `up` once on a newly created
database, then again to confirm the no-op — the CLI prints
`applied: ...; skipped (already applied): ...` on every run, so the
second run must show `applied: (none)`. The integration suite also
proves both paths automatically:
`tests/integration/account/migrations.test.ts` migrates 0001 → 0002, exercises
the mixed-factor and ambiguous-factor upgrade cases, checks recovery-code
preservation and legacy challenge expiration, re-runs `up` as a no-op, then
drops and re-migrates the full chain from scratch and repeats the no-op.

## API smoke test (registration → login → session roundtrip)

With the API running against the isolated stack:

```powershell
$env:DATABASE_URL='postgres://wai_dev:wai_dev_pg_8f3k@127.0.0.1:35433/wai_dev'
$env:VALKEY_URL='redis://:wai_dev_valkey_9q2x@127.0.0.1:36380'
pnpm --filter @wai/api dev
```

Then, in a second shell (Git Bash shown):

```bash
# Registration (201, sets no cookies yet)
curl -si -X POST http://127.0.0.1:3100/v1/account/registrations \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.invalid","password":"correct horse battery staple"}'

# Login (201, sets wai_session_dev HttpOnly cookie; save the cookie jar)
curl -si -c /tmp/wai.jar -X POST http://127.0.0.1:3100/v1/account/sessions \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.invalid","password":"correct horse battery staple"}'

# Session roundtrip (200, returns the session summary)
curl -s -b /tmp/wai.jar http://127.0.0.1:3100/v1/account/session

# Wrong password (401 INVALID_CREDENTIALS, indistinguishable from unknown email)
curl -si -X POST http://127.0.0.1:3100/v1/account/sessions \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.invalid","password":"wrong"}'

# Logout (204, session revoked server-side)
curl -si -b /tmp/wai.jar -X DELETE http://127.0.0.1:3100/v1/account/session
```

All responses carry the FND-01 envelope `{code, message, details?,
request_id}` and an `x-request-id` header. Emails are fictional
(`*.invalid`); no real PII is ever used.

## IAM test suites

From the repository root (containers from `wai-iam-01-claude` or the
default project both work — the integration suite starts its own
Testcontainers):

```powershell
pnpm test:iam:unit          # domain unit tests (fakes, fixed clock)
pnpm test:iam:contracts     # Zod contract schemas
pnpm test:iam:provider      # real Argon2id/otpauth compliance vs the mock
pnpm test:iam:integration   # real Postgres/Valkey: auth, sessions, MFA, devices
pnpm test:iam:migration     # migrations on a fresh database
```

`test:iam:integration` runs with `--no-file-parallelism`: every test
file starts its own Postgres/Valkey container pair, and serializing the
files keeps parallel container startup/teardown from contending on
Docker Desktop (the empirical failure mode was Valkey connection errors
in 5 device cases under parallel files). The flag lives in the script
itself because vitest 3.2.6 does not honor the config-level
`fileParallelism: false` under the `--project integration` filter. The
suite is expected to leave zero test containers behind; each run also
proves the infra cleanup path (`tests/integration/account/infra-cleanup.test.ts`
forces a Valkey startup failure and asserts the Postgres container is
stopped).

Full regression: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e`,
`pnpm audit --audit-level=high`.

## Operational notes

- Session cookies are HttpOnly + SameSite=Lax; production uses
  `__Host-wai_session` (browsers enforce Secure). Dev uses
  `wai_session_dev` over http://localhost.
- Sessions are opaque: the database stores only HMAC digests. MFA
  enable/disable rotates the session (the old token is revoked, a
  successor is issued, and a replayed rotated token burns the whole
  family); logout and session-list revocation instead revoke the
  session server-side without issuing a successor — no replay
  semantics.
- Rate limits (Valkey, IP + email-digest) answer `429 RATE_LIMITED`;
  repeated failed logins for one account are throttled per digest, so an
  attacker cannot enumerate emails through response timing.
