# ADR 0003 — ELG-01 Eligibility Policy Engine

- Status: accepted
- Date: 2026-08-17
- Deciders: ELG-01 implementation engineer (Claude Code, user-configured
  DeepSeek model)
- Scope: jurisdiction declarations, age evidence/credentials, mode and
  partition admission decisions behind Open Policy Agent — API only, no UI

## Context

The Women AI Network must gate relationship modes (friends, dating, …)
and youth/adult partitions on jurisdiction + age before any member-facing
social feature exists. ELG-01 ships: a jurisdiction declaration per
account, an encrypted self-declared birthday, derived age credentials,
versioned jurisdiction policies, single-subject mode evaluations and
two-party partition evaluations — all decided by Open Policy Agent (OPA)
as an independent sidecar, behind the FND-01/IAM-01 foundation without
breaking any of its invariants (SessionAuthGuard, account state machine,
PII encryption/redaction).

The task book (docs/tasks/ELG-01.md) fixes the design: OPA `1.17.0`
(Rego v1, REST Data API, image pinned — never `latest`), age computed
with `@js-temporal/polyfill@0.5.1` `Temporal.PlainDate` in the policy's
IANA timezone (never `Date.now - dob`, UTC date arithmetic, or division
by 365), and OPA located strictly behind `AgeModePolicyDecisionPort` so
no account ID, birthday, email, IP, device, name, document or photo can
ever reach the policy engine. No real-country policies are seeded; the
module ships a synthetic US-shaped policy for local development and the
ops insert path.

## Decisions

### D1. OPA 1.17.0 pinned as a localhost sidecar; policies bind-mounted read-only

`openpolicyagent/opa:1.17.0-static` (Apache-2.0, scratch image — no
shell) runs as its own compose service on `127.0.0.1:8181` (default),
started with `run --server --addr :8181 /policy`. The Rego package
(`packages/authz/policies`, `data.eligibility`) is bind-mounted read-only
so local edits take effect without rebuilds. The image is scratch, so the
healthcheck is a plain `CMD` (`opa eval --data /policy --format raw
'count(data.eligibility) > 0'`), which also fails when the packages did
not resolve. Testcontainers (`packages/testkit/src/eligibility/opa.ts`)
uses the same pinned image for integration tests. Upgrading OPA requires
re-running the Rego test matrix (59 tests, 97.06% coverage) before merge.

### D2. OPA sits behind the decision ports; only derived, PII-free documents cross

`AgeModePolicyDecisionPort` and `AgePartitionDecisionPort`
(`packages/contracts/src/eligibility/ports.ts`) are the only doors to
OPA. The inputs are pre-derived documents:

- `subject`: `age_years`, `age_band`, `cohort_key`, `assurance_level` —
  never the birthday, and never an account identifier.
- `policy`: the full non-PII policy document (thresholds, cohort
  allowlist, per-mode rules) reconstructed from the DB snapshot at
  evaluation time — the document is sent whole so the engine is
  deterministic and reproducible from the stored `content_hash`.
- `request`: mode/capability + `effective_at` only.

`partition_decision` carries two subject documents (actor/subject) and
two policy documents — still no identity, no birthday, no contact
information. The schemas are Zod `.strict()` and forbid unknown fields.
The privacy suite
(`tests/integration/eligibility/privacy.test.ts`) asserts on a real OPA
container that no birthday plaintext reaches OPA inputs, decision rows,
snapshots, responses, or logs.

### D3. The adapter fails closed on every anomaly

`OpaModeDecisionAdapter`/`OpaPartitionDecisionAdapter`
(`packages/authz/src/opa-adapter.ts`) treat every anomaly as a deny
reason `OPA_EVALUATION_FAILED` and record a `policy_events` row:

- OPA unreachable, timeout (AbortSignal, default 3000 ms) or non-2xx →
  deny.
- Malformed or non-whitelisted output (Zod `.strict()` + reason/obligation
  whitelists, `packages/contracts/src/eligibility/opa.ts`) → deny; an
  unknown `reason_code` invalidates the whole result.
- A stored policy whose content fails schema validation at load time →
  `500 policy_validation_failure` (fail closed — nothing is guessed).

### D4. Age is calendar math in the policy timezone — Temporal only

Age is computed from the encrypted evidence with
`Temporal.PlainDate` in the active jurisdiction policy's IANA timezone
(`effective_at.toZonedDateTimeISO(timezone)`), as calendar years between
`PlainDate`s. Leap-day birthdays, DST transitions and timezone shifts are
covered by an explicit boundary test table. `Date.now - dob`, UTC
date-difference and `/365` are prohibited. The response exposes only
`age_band`/`cohort_key`/`assurance_level`/`valid_until` — never the
birthday.

### D5. Policies are versioned, immutable-after-approval snapshots

`eligibility.jurisdiction_policies` keyed by `jurisdiction_key + revision`,
with a GiST `EXCLUDE` overlap constraint on
`(jurisdiction_key, tstzrange(effective_from, effective_until))` so
effective ranges can never overlap. `is_synthetic` marks harness-seeded
documents. The `jurisdiction_policies_guard` trigger enforces the only
legal transition: `approved → retired`; any other UPDATE of an approved
row is rejected, as is DELETE (cascaded deletes from a schema rollback
still pass). Every row carries a `content_hash` of the canonical policy
document so history is reproducible byte-for-byte. The migration
(`0003_eligibility.sql`) installs `btree_gist` for the EXCLUDE index and
leaves it installed on rollback (documented in the migration).

### D6. The birthday exists only as ciphertext

`eligibility.age_evidence` stores the self-declared birthday as
AES-256-GCM ciphertext + nonce/tag + key ID (the `@wai/db` crypto
infrastructure shared with IAM), at most one current row per account.
The raw value exists only while parsing/encrypting: never in logs,
traces, error details, OPA input, snapshots or responses.

### D7. Age credentials are immutable snapshots derived at declaration time

`eligibility.age_credentials` is written once per declaration
(`age_credentials_guard` forbids UPDATE/DELETE), captures
`age_band/cohort_key/assurance_level` plus the policy id/revision it was
derived under, and `valid_until = min(credential.valid_until,
policy.effective_until)` — a credential never outlives the policy that
issued it. `externally_attested` can only be produced by a future VER-01
module through the internal `AgeCredentialIssuer` port; a public HTTP
body can never claim verification.

### D8. Decision rows are append-only and idempotent by construction

`mode_decisions` and `partition_decisions` are append-only (dedicated
triggers), storing input/policy/credential hashes and a deterministic
`decision_id` — `sha256` over the canonical (actor, subject,
capability, effective_at, policy/credential ids, input_hash) tuple
mapped to a UUID v5 (version nibble 5, enforced by
`decisionIdSchema`). The same tuple re-evaluated yields the same id, so
retries land on one row and never duplicate records.

### D9. The partition port is internal; no public route exposes two-party decisions

`PartitionDecisionService` is exported from `eligibility.module.ts`
with an explicit no-public-route comment; integration tests call it via
`api.get(...)`. A single-subject public decision must never imply
information about another account.

### D10. OPA config loads in apps/api (recorded deviation)

`ELG_OPA_URL` (dev default `http://127.0.0.1:8181`, production rejects
the dev default) and `ELG_OPA_QUERY_TIMEOUT_MS` are validated in
`apps/api/src/eligibility/infra/opa-config.ts` — inside `apps/api`
because `packages/config/src/index.ts` is not on the task book's
allowed-modification list. The file header records this deviation.

### D11. Explicit non-goals (task book §1.2)

No ID documents, liveness, face or unique-human checks; no gender
inference; no female-membership application/review/verification
workflows (VER-01); no parental-consent workflow — only the
`PARENTAL_CONSENT_REQUIRED` obligation/reason code; no profile,
matching, chat, events or dating business logic; no real-country policy
seeds; no VER-01 work and no frontend registration/login pages.

## Consequences

- Every new mode or threshold change is a policy document change: seed a
  new revision through the ops path, re-run the Rego matrix, and the
  effective-time history makes any evaluation reproducible.
- The OPA data API is bound to localhost only; the engine never touches
  the database or any account identity — a compromised OPA cannot read
  PII and a compromised API cannot manufacture an allow.
- OPA upgrades are deliberate acts: pinned image + coverage gate +
  compliance integration suite.
- Youth/adult interaction rules live in one place (Rego) and are
  exercised by both single-subject and two-party suites; the
  `dating_under_adult_threshold_is_denied` and
  `youth_adult_cross_partition_is_denied` acceptance behaviors are
  pinned by integration tests on a real OPA container.
- Anything that needs "who may interact with whom" must call the
  partition service — there is no public route and no data export of
  other accounts' partitions.
