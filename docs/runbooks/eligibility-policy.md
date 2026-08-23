# Runbook — Eligibility Policy Engine (ELG-01)

This runbook is written for **Windows 11 + PowerShell** (also works in Git
Bash). All commands are copy-paste ready.

## What is here

The ELG-01 engine answers two questions per account: (1) which age
partition does this account fall into in its declared jurisdiction at a
given time, and (2) is this account allowed into a relationship mode
(friends, dating, …) or into a two-party partition. Decisions are made
by Open Policy Agent (OPA) as an independent sidecar; the API never
sends identity or PII to OPA.

Ports (defaults): Postgres `5433`, Valkey `6380`, OPA `8181`
(localhost-bound only).

## 1. Start the stack

```powershell
docker compose up -d --wait
docker compose ps          # postgres / opa / valkey must all show (healthy)
```

OPA health (the scratch image has no shell, so `curl` inside the
container is impossible; probe the host port instead):

```powershell
curl.exe -s http://127.0.0.1:8181/health
# {"status":"ok"}
```

The compose healthcheck itself runs `opa eval --data /policy --format
raw 'count(data.eligibility) > 0'` — it fails when the Rego package did
not resolve, not only when the server is down.

Running a second, isolated stack for verification (non-default ports):

```powershell
$env:POSTGRES_HOST_PORT='15433'; $env:VALKEY_HOST_PORT='16380'; $env:OPA_HOST_PORT='18181'
docker compose --project-name wai-elg-hardening up -d --wait
docker compose --project-name wai-elg-hardening down -v   # full cleanup, volumes too
```

## 2. Migrate the database

```powershell
pnpm --filter @wai/db exec tsx src/cli/migrate.ts up
# applies 0001_iam_account.sql, 0002_iam_r1.sql, 0003_eligibility.sql in order
```

- Re-running `up` is a no-op (tracker rows).
- `down` rolls back the last file only (`0003_eligibility.sql` drops the
  whole `eligibility` schema; `btree_gist` stays installed by design).
- Override the connection with `DATABASE_URL`; the dev default is
  `postgres://wai_dev:wai_dev_pg_8f3k@127.0.0.1:5433/wai_dev`.

## 3. Seed a jurisdiction policy (ops path)

There is intentionally **no API route to create or modify policies** —
the API is fail-closed on the read side and policies are ops/harness
seeds. Until at least one approved policy exists for the account's
jurisdiction, every evaluation answers `400 no_active_jurisdiction_policy`.

The reference seed lives in
`tests/integration/eligibility/seed.ts` (`insertApprovedPolicy`) and
inserts into `eligibility.jurisdiction_policies`:

| Column                               | Value                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `id`                                 | UUID (fixed, e.g. `11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b`)                            |
| `jurisdiction_key`                   | `US`, or `US-CA` style subdivision                                                   |
| `revision`                           | integer ≥ 1; `(jurisdiction_key, revision)` unique                                   |
| `status`                             | `approved`                                                                           |
| `content`                            | full `PolicyDocument` JSON (see below)                                               |
| `content_hash`                       | `canonicalJsonHash(content)`                                                         |
| `rule_hash`                          | hash of the decision-relevant rules subset                                           |
| `timezone`                           | IANA, e.g. `America/New_York` — age math runs in this timezone                       |
| `effective_from` / `effective_until` | `timestamptz`; open end = `'infinity'`; ranges must not overlap (EXCLUDE constraint) |
| `is_synthetic`                       | `true` for harness/ops seeds                                                         |
| `created_at`                         | required, no DB default                                                              |

The stored `content` must satisfy the strict `policyDocumentSchema`
(`packages/contracts/src/eligibility/opa.ts`): thresholds, cohort
allowlist, and `mode_rules` with **all six modes** explicit
(`friends`, `activities`, `professional`, `circles`, `events`,
`dating`) for `mode_enabled`, `platform_minimum_age_by_mode`,
`mode_minimum_age` and `required_age_assurance_by_mode`. A missing or
invalid stored document makes every evaluation fail closed with
`500 policy_validation_failure` — the selector re-validates content on
every read.

Once approved, a policy is immutable: the only legal UPDATE transition
is `approved → retired`, direct DELETE is blocked by trigger, and
revisions are added as new rows.

## 4. Smoke the eligibility API

The API has no public register/login of its own — reuse the IAM routes,
then exercise the eligibility vertical:

```powershell
$base = 'http://127.0.0.1:3101'   # or :3000 with `pnpm dev`

# 1. register + login (IAM)
curl.exe -s -c cookies.txt -X POST $base/v1/account/registrations -H "Content-Type: application/json" `
  -d '{"email":"member@example.invalid","password":"correct horse battery staple"}'
curl.exe -s -b cookies.txt -c cookies.txt -X POST $base/v1/account/sessions -H "Content-Type: application/json" `
  -d '{"email":"member@example.invalid","password":"correct horse battery staple"}'

# 2. jurisdiction + age declaration (strict ISO date-only birthday)
curl.exe -s -b cookies.txt -X PUT $base/v1/eligibility/jurisdiction -H "Content-Type: application/json" -d '{"country_code":"US"}'
curl.exe -s -b cookies.txt -X PUT $base/v1/eligibility/age-declaration -H "Content-Type: application/json" -d '{"birth_date":"2000-01-01"}'

# 3. status + mode evaluation
curl.exe -s -b cookies.txt $base/v1/eligibility/status
curl.exe -s -b cookies.txt -X POST $base/v1/eligibility/mode-evaluations -H "Content-Type: application/json" -d '{"mode":"dating"}'
```

Expected: registration `201`, session `201`, jurisdiction `200`,
age-declaration `200` (adult credential), status `200` (active policy +
timezone), mode-evaluations `200` with `decision: "allow"` for an adult
under the synthetic US policy. Re-declaring the same birthday is
idempotent (same credential hash).

Fail-closed checks to prove when a stack is unseeded: no policy for the
jurisdiction → `400 no_active_jurisdiction_policy`; policy content that
fails validation → `500 policy_validation_failure`.

## 5. Privacy constraints (non-negotiable)

- The raw birthday exists only while parsing/encrypting; the database
  keeps AES-256-GCM ciphertext + key ID, never plaintext.
- OPA receives only derived documents (`age_years`, `age_band`,
  `cohort_key`, `assurance_level`, policy document, mode/capability +
  `effective_at`) — never account IDs, birthday, email, IP, device,
  name, documents or photos.
- Responses expose only `age_band`, `cohort_key`, `assurance_level`,
  `valid_until` — never the birthday.

## 6. Verification commands

```powershell
pnpm test:elg:policy        # Rego matrix on the pinned OPA image
pnpm test:elg:unit          # domain + adapter unit tests
pnpm test:elg:integration   # jurisdiction/credential/mode/partition on real containers
pnpm test:elg:privacy       # PII-absence suite
pnpm test:elg:migration     # 0003 migration lifecycle
```
