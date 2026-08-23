# ELG-01 eligibility policy (task book §5, CP3).
#
# Two decision points, one per package:
#   eligibility.mode_decision      — single-subject mode evaluation
#   eligibility.partition_decision — two-party capability partition
#
# The input contract lives in packages/contracts/src/eligibility/opa.ts and
# is derived, PII-free: no account IDs, birthdays, emails, IPs, devices,
# names, documents or photos may ever reach OPA.
#
# Fail-closed discipline: every missing field, missing mode rule or
# inconsistent subject document lands on ELIGIBILITY_INCOMPLETE; missing
# mode switches land on MODE_DISABLED. There is no truthy default path.
#
# Reason codes are emitted in the fixed order of the reason-code enum
# (packages/contracts/src/eligibility/enums.ts — "first applicable wins").
#
# Document discipline: the engine's HTTP surface is queried at
# /v1/data/eligibility/mode_decision, and OPA returns the WHOLE package
# document. Only the three output rules (decision/reason_codes/obligations)
# may therefore exist as RULES — every intermediate computation is a
# FUNCTION, and functions never appear in the document. Rego v1 forbids
# zero-argument functions, so each helper takes the input document as an
# explicit `ctx` parameter (a function argument must not shadow `input`).
# Anything else would silently widen the strict zod output contract in
# packages/authz/src/output-schema.ts.
#
# Rego v1 notes: bodies with more than one expression must be braced
# (`if { ... }`); the `and` keyword was removed in OPA 1.x — expressions
# are implicitly conjoined line by line.

package eligibility.mode_decision

import rego.v1

default decision := "deny"

default reason_codes := []

default obligations := []

# Effective minimum account age for one mode (task book core formula):
#   max(minimum_account_age, platform_minimum_age_by_mode[mode],
#       mode_minimum_age[mode], dating ? 18 : 0, dating ? age_of_majority : 0)
# A missing per-mode rule makes the whole function undefined, which the
# completeness checks below turn into ELIGIBILITY_INCOMPLETE.
# (Rego v1 has no ternary — the dating floors are separate functions.)
dating_floor(mode) := 18 if mode == "dating"

dating_floor(mode) := 0 if mode != "dating"

majority_floor(policy, mode) := policy.age_of_majority if mode == "dating"

majority_floor(policy, mode) := 0 if mode != "dating"

effective_minimum(policy, mode) := max([
    policy.minimum_account_age,
    policy.mode_rules.platform_minimum_age_by_mode[mode],
    policy.mode_rules.mode_minimum_age[mode],
    dating_floor(mode),
    majority_floor(policy, mode),
])

# -- input completeness (defense in depth; the adapter pre-validates) -------
incomplete(ctx) if not ctx.policy

incomplete(ctx) if not ctx.policy.mode_rules

incomplete(ctx) if not ctx.policy.mode_rules.mode_enabled

incomplete(ctx) if not ctx.policy.mode_rules.platform_minimum_age_by_mode

incomplete(ctx) if not ctx.policy.mode_rules.mode_minimum_age

incomplete(ctx) if not ctx.policy.mode_rules.required_age_assurance_by_mode

incomplete(ctx) if not ctx.policy.minimum_account_age

incomplete(ctx) if not ctx.policy.age_of_majority

incomplete(ctx) if not ctx.policy.parental_consent_required_below

incomplete(ctx) if not ctx.policy.youth_launch_state

incomplete(ctx) if not ctx.policy.allowed_cohorts

incomplete(ctx) if not ctx.subject

incomplete(ctx) if not ctx.subject.age_years

incomplete(ctx) if not ctx.subject.age_band

incomplete(ctx) if not ctx.subject.cohort_key

incomplete(ctx) if not ctx.subject.assurance_level

incomplete(ctx) if not ctx.request

incomplete(ctx) if not ctx.request.mode

# The derived document must be self-consistent with the policy it cites:
# bands and cohort keys follow deriveAgeBand/deriveCohortKey in
# apps/api/src/eligibility/domain/policy.ts. A mismatch means the input was
# corrupted — fail closed instead of trusting the subject document.
incomplete(ctx) if not ctx.subject.age_band in {"below_minimum", "youth", "adult"}

incomplete(ctx) if {
    ctx.subject.age_band == "below_minimum"
    ctx.subject.age_years >= ctx.policy.minimum_account_age
}

incomplete(ctx) if {
    ctx.subject.age_band == "youth"
    ctx.subject.age_years >= ctx.policy.age_of_majority
}

incomplete(ctx) if {
    ctx.subject.age_band == "adult"
    ctx.subject.age_years < ctx.policy.age_of_majority
}

# Missing per-mode minimums (platform or mode) must never yield an empty
# deny list — an uncomputable threshold is an incomplete document.
incomplete(ctx) if not effective_minimum(ctx.policy, ctx.request.mode)

# -- per-check deny conditions (fixed evaluation order) ---------------------

# 4. BELOW_MINIMUM_ACCOUNT_AGE
below_minimum_account_age(ctx) if ctx.subject.age_years < ctx.policy.minimum_account_age

# 5. PARENTAL_CONSENT_REQUIRED (also carries the parental-consent obligation)
parental_consent_required(ctx) if ctx.subject.age_years < ctx.policy.parental_consent_required_below

# 6. YOUTH_NOT_LAUNCHED — youth band only; adult access is governed by the
#    per-mode thresholds, so an unlisted "adult" cohort is not a launch gate.
youth_not_launched(ctx) if {
    ctx.subject.age_band == "youth"
    not ctx.policy.youth_launch_state == "launched"
}

youth_not_launched(ctx) if {
    ctx.subject.age_band == "youth"
    not ctx.subject.cohort_key in ctx.policy.allowed_cohorts
}

# 7. MODE_DISABLED — a missing mode switch is treated as disabled.
mode_enabled(ctx) := ctx.policy.mode_rules.mode_enabled[ctx.request.mode]

mode_disabled(ctx) if not mode_enabled(ctx)

# 8. MODE_MINIMUM_AGE_NOT_MET — non-dating modes.
mode_minimum_age_not_met(ctx) if {
    ctx.request.mode != "dating"
    ctx.subject.age_years < effective_minimum(ctx.policy, ctx.request.mode)
}

# 9. ADULT_THRESHOLD_NOT_MET — dating embeds max(18, age_of_majority), so a
#    youth subject below that floor fails the adult threshold specifically.
adult_threshold_not_met(ctx) if {
    ctx.request.mode == "dating"
    ctx.subject.age_years < effective_minimum(ctx.policy, "dating")
}

# 10. AGE_ASSURANCE_REQUIRED — a missing required level is treated as the
#     strongest requirement.
required_assurance(ctx) := ctx.policy.mode_rules.required_age_assurance_by_mode[ctx.request.mode]

assurance_met(ctx) if required_assurance(ctx) == "self_declared"

assurance_met(ctx) if {
    required_assurance(ctx) == "externally_attested"
    ctx.subject.assurance_level == "externally_attested"
}

age_assurance_required(ctx) if not assurance_met(ctx)

# -- stable, fixed-order reason list ----------------------------------------
# Iterating the ordered array keeps "first applicable code wins" (task book
# §5) even though Rego maps are unordered. The old `|` comprehension sugar
# is gone in rego.v1, so each code maps to its rule via rule_holds().
reason_order(ctx) := [
    "ELIGIBILITY_INCOMPLETE",
    "NO_ACTIVE_JURISDICTION_POLICY",
    "JURISDICTION_REVIEW_REQUIRED",
    "BELOW_MINIMUM_ACCOUNT_AGE",
    "PARENTAL_CONSENT_REQUIRED",
    "YOUTH_NOT_LAUNCHED",
    "MODE_DISABLED",
    "MODE_MINIMUM_AGE_NOT_MET",
    "ADULT_THRESHOLD_NOT_MET",
    "AGE_ASSURANCE_REQUIRED",
    "CROSS_COHORT_DENIED",
    "POLICY_ENGINE_UNAVAILABLE",
    "POLICY_OUTPUT_INVALID",
    "ACCOUNT_NOT_ENABLED",
]

rule_holds(ctx, "BELOW_MINIMUM_ACCOUNT_AGE") if below_minimum_account_age(ctx)

rule_holds(ctx, "PARENTAL_CONSENT_REQUIRED") if parental_consent_required(ctx)

rule_holds(ctx, "YOUTH_NOT_LAUNCHED") if youth_not_launched(ctx)

rule_holds(ctx, "MODE_DISABLED") if mode_disabled(ctx)

rule_holds(ctx, "MODE_MINIMUM_AGE_NOT_MET") if mode_minimum_age_not_met(ctx)

rule_holds(ctx, "ADULT_THRESHOLD_NOT_MET") if adult_threshold_not_met(ctx)

rule_holds(ctx, "AGE_ASSURANCE_REQUIRED") if age_assurance_required(ctx)

rule_holds(ctx, "ELIGIBILITY_INCOMPLETE") if incomplete(ctx)

deny_reasons(ctx) := [code |
    some i, code in reason_order(ctx)
    rule_holds(ctx, code)
]

reason_codes := deny_reasons(input)

obligations := ["parental_consent_required"] if parental_consent_required(input)

decision := "allow" if count(deny_reasons(input)) == 0

decision := "deny" if count(deny_reasons(input)) > 0
