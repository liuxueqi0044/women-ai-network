# Policy — Age & Jurisdiction Admission (ELG-01)

This document specifies the jurisdiction policy document (`PolicyDocument`),
the evaluation semantics of the eligibility engine, and the fixed reason
codes. It is the reference for anyone writing, seeding or reviewing a
jurisdiction policy. The code of record is
`packages/contracts/src/eligibility/opa.ts` (schema), the Rego in
`packages/authz/policies/`, and the migration `0003_eligibility.sql`.

## 1. Non-goals and data boundaries

- This engine answers **age partition** and **mode/capability admission**
  only. It never asserts identity, gender, membership, liveness or
  document authenticity (VER-01).
- OPA receives only **derived documents**: age facts (`age_years`,
  `age_band`, `cohort_key`, `assurance_level`), the policy document
  itself, and the request (mode/capability + `effective_at`). Account
  IDs, birthdays, emails, IPs, devices, names, documents and photos are
  forbidden.
- The raw birthday exists only during parse/encrypt; the database keeps
  AES-256-GCM ciphertext; responses return only `age_band`,
  `cohort_key`, `assurance_level`, `valid_until`.
- No real-country policies are seeded by this module. The reference
  policy below is a synthetic US-shaped document for development and
  tests (`is_synthetic = true`); real jurisdictions require legal
  review and are published through the ops path
  (`docs/runbooks/eligibility-policy.md` §3).

## 2. The policy document

```json
{
  "policy_id": "11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b",
  "revision": 1,
  "minimum_account_age": 13,
  "age_of_majority": 18,
  "digital_consent_age": 16,
  "parental_consent_required_below": 16,
  "youth_launch_state": "launched",
  "allowed_cohorts": ["youth_13", "youth_14", "youth_15", "youth_16", "youth_17", "adult"],
  "cross_cohort_contact_policy": "same_cohort_only",
  "mode_rules": {
    "mode_enabled": {
      "friends": true,
      "activities": true,
      "professional": true,
      "circles": true,
      "events": true,
      "dating": true
    },
    "platform_minimum_age_by_mode": {
      "friends": 13,
      "activities": 13,
      "professional": 13,
      "circles": 13,
      "events": 13,
      "dating": 18
    },
    "mode_minimum_age": {
      "friends": 0,
      "activities": 0,
      "professional": 0,
      "circles": 0,
      "events": 0,
      "dating": 0
    },
    "required_age_assurance_by_mode": {
      "friends": "self_declared",
      "activities": "self_declared",
      "professional": "self_declared",
      "circles": "self_declared",
      "events": "self_declared",
      "dating": "self_declared"
    }
  }
}
```

Every `mode_rules` map must define **all six modes** (`friends`,
`activities`, `professional`, `circles`, `events`, `dating`) — a missing
mode makes the policy unloadable, not "false by convention". The stored
content is re-validated on every read and fails closed otherwise.

### 2.1 Field semantics

| Field                                       | Meaning                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `minimum_account_age`                       | lowest age at which an account may exist in this jurisdiction.                                             |
| `age_of_majority`                           | the adult threshold; only `age_band = adult` may date or cross the youth/adult partition.                  |
| `digital_consent_age`                       | documented consent age (informational; `parental_consent_required_below` drives the obligation).           |
| `parental_consent_required_below`           | subjects below this age receive the `parental_consent_required` obligation on allow.                       |
| `youth_launch_state`                        | `launched` or `not_launched`; when `not_launched`, no youth cohort is admitted.                            |
| `allowed_cohorts`                           | per-cohort allowlist (`youth_<age>`, `adult`); a cohort absent from the list is not admitted.              |
| `cross_cohort_contact_policy`               | `same_cohort_only` (default), `adjacent_cohorts`, or `all_youth` — governs youth↔youth partition contact. |
| `mode_rules.mode_enabled`                   | mode switch; a disabled mode is `MODE_DISABLED` before any age check.                                      |
| `mode_rules.platform_minimum_age_by_mode`   | platform floor per mode.                                                                                   |
| `mode_rules.mode_minimum_age`               | policy floor per mode (e.g. dating 21 where the law requires it).                                          |
| `mode_rules.required_age_assurance_by_mode` | `self_declared` (default) or `externally_attested` (VER-01 only — a public body can never self-claim).     |

## 3. Age bands, cohorts and age math

- Fixed bands: `unknown | below_minimum | youth | adult`.
- Per-year cohorts: `below_minimum`, `youth_<age>` (e.g. `youth_15`),
  `adult`. "Same cohort" means the same exact age in years.
- Age is calendar years between `Temporal.PlainDate`s computed in the
  **policy's IANA timezone** at `effective_at` (DST/leap-day safe).
  `Date.now − dob`, UTC date-difference and division by 365 are
  forbidden.

## 4. Mode decision semantics (`eligibility.mode_decision`)

Evaluation order — **first applicable reason code wins** (fixed, never
reordered):

1. `ELIGIBILITY_INCOMPLETE` — any missing input field/mode rule.
2. `NO_ACTIVE_JURISDICTION_POLICY` — no approved policy covers the
   jurisdiction at `effective_at` (API answers `400`).
3. `JURISDICTION_REVIEW_REQUIRED` — declaration pending review.
4. `BELOW_MINIMUM_ACCOUNT_AGE` — under `minimum_account_age`.
5. `PARENTAL_CONSENT_REQUIRED` — under `parental_consent_required_below`
   (deny, with the obligation on allow paths where configured).
6. `YOUTH_NOT_LAUNCHED` — youth cohort but `youth_launch_state =
not_launched`, or cohort not in `allowed_cohorts`.
7. `MODE_DISABLED` — `mode_enabled[mode] = false`.
8. `MODE_MINIMUM_AGE_NOT_MET` / `ADULT_THRESHOLD_NOT_MET` — below the
   effective minimum for the mode (below) or below the adult threshold
   (dating).
9. `AGE_ASSURANCE_REQUIRED` — assurance below the mode requirement.
10. `ACCOUNT_NOT_ENABLED` — reserved for the IAM guard (enforced by
    SessionAuthGuard, not by the engine).

**Effective minimum for a mode** (the core formula):

```
max(
  minimum_account_age,
  platform_minimum_age_by_mode[mode],
  mode_minimum_age[mode],
  mode == "dating" ? 18 : 0,
  mode == "dating" ? age_of_majority : 0,
)
```

**Dating is a hard gate**: dating always requires
`max(18, age_of_majority, …)` regardless of other floors, and an
`adult` band (never a youth band) is required to pass.

## 5. Partition decision semantics (`eligibility.partition_decision`)

Internal port only — there is no public HTTP route for two-party
decisions. The five capabilities map onto mode rules:

| Capability                                | Inherits mode rules of     |
| ----------------------------------------- | -------------------------- |
| `discover`, `introduce`, `direct_message` | `friends`                  |
| `event_visibility`                        | `events`                   |
| `dating`                                  | `dating` (hard gate above) |

Both parties are evaluated independently against their own
jurisdiction policies; a capability is allowed only if **both** sides
pass and the partition rule holds:

- Adult↔youth contact is **denied** for every capability
  (`CROSS_COHORT_DENIED` — the youth/adult cross-partition invariant).
- Youth↔youth contact follows `cross_cohort_contact_policy`
  (`same_cohort_only` / `adjacent_cohorts` / `all_youth`).

## 6. Obligations

Closed set: `parental_consent_required`. An allow decision may carry it;
the engine never renders a parental-consent workflow (that is out of
scope for ELG-01).

## 7. Determinism and auditability

- Decisions are append-only rows with a deterministic `decision_id`
  (sha256 of the full input tuple → UUID v5) — retries land on one row.
- Each row stores input/policy/credential hashes, the policy
  `revision`, and `engine_version = 1`; any evaluation can be
  reproduced from stored state.
- Policies are immutable after `approved` (only `approved → retired` is
  a legal UPDATE; DELETE is blocked; effective ranges may not overlap).
