# ELG-01 two-party partition decision (internal port — never a public query
# API). See eligibility_mode_decision.rego for shared fail-closed discipline.
#
# Document discipline (same as mode_decision): only decision/reason_codes/
# obligations exist as RULES — every intermediate is a FUNCTION taking the
# input document as `ctx` (rego.v1 forbids zero-argument functions and a
# function argument must not shadow `input`).

package eligibility.partition_decision

import rego.v1

default decision := "deny"

default reason_codes := []

default obligations := []

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

# Capability → mode-rule mapping. The five partition capabilities inherit
# the rules of the closest relationship mode; dating is its own hard gate.
capability_mode(cap) := "friends" if cap in {"discover", "introduce", "direct_message"}

capability_mode(cap) := "events" if cap == "event_visibility"

capability_mode(cap) := "circles" if cap == "circles"

capability_mode(cap) := "dating" if cap == "dating"

# -- input completeness ------------------------------------------------------
incomplete(ctx) if not ctx.actor_policy

incomplete(ctx) if not ctx.subject_policy

incomplete(ctx) if not ctx.actor

incomplete(ctx) if not ctx.subject

incomplete(ctx) if not ctx.request

incomplete(ctx) if not ctx.request.capability

incomplete(ctx) if not ctx.request.capability in {"discover", "introduce", "direct_message", "circles", "event_visibility", "dating"}

incomplete(ctx) if not ctx.actor_policy.mode_rules

incomplete(ctx) if not ctx.actor_policy.mode_rules.mode_enabled

incomplete(ctx) if not ctx.actor_policy.mode_rules.platform_minimum_age_by_mode

incomplete(ctx) if not ctx.actor_policy.mode_rules.mode_minimum_age

incomplete(ctx) if not ctx.actor_policy.mode_rules.required_age_assurance_by_mode

incomplete(ctx) if not ctx.actor_policy.minimum_account_age

incomplete(ctx) if not ctx.actor_policy.age_of_majority

incomplete(ctx) if not ctx.actor_policy.parental_consent_required_below

incomplete(ctx) if not ctx.actor_policy.youth_launch_state

incomplete(ctx) if not ctx.actor_policy.allowed_cohorts

incomplete(ctx) if not ctx.subject_policy.mode_rules

incomplete(ctx) if not ctx.subject_policy.mode_rules.mode_enabled

incomplete(ctx) if not ctx.subject_policy.mode_rules.platform_minimum_age_by_mode

incomplete(ctx) if not ctx.subject_policy.mode_rules.mode_minimum_age

incomplete(ctx) if not ctx.subject_policy.mode_rules.required_age_assurance_by_mode

incomplete(ctx) if not ctx.subject_policy.minimum_account_age

incomplete(ctx) if not ctx.subject_policy.age_of_majority

incomplete(ctx) if not ctx.subject_policy.parental_consent_required_below

incomplete(ctx) if not ctx.subject_policy.youth_launch_state

incomplete(ctx) if not ctx.subject_policy.allowed_cohorts

incomplete(ctx) if not ctx.actor.age_years

incomplete(ctx) if not ctx.actor.age_band

incomplete(ctx) if not ctx.actor.cohort_key

incomplete(ctx) if not ctx.actor.assurance_level

incomplete(ctx) if not ctx.subject.age_years

incomplete(ctx) if not ctx.subject.age_band

incomplete(ctx) if not ctx.subject.cohort_key

incomplete(ctx) if not ctx.subject.assurance_level

incomplete(ctx) if not ctx.actor.age_band in {"below_minimum", "youth", "adult"}

incomplete(ctx) if not ctx.subject.age_band in {"below_minimum", "youth", "adult"}

incomplete(ctx) if {
    ctx.actor.age_band == "below_minimum"
    ctx.actor.age_years >= ctx.actor_policy.minimum_account_age
}

incomplete(ctx) if {
    ctx.subject.age_band == "below_minimum"
    ctx.subject.age_years >= ctx.subject_policy.minimum_account_age
}

incomplete(ctx) if {
    ctx.actor.age_band == "youth"
    ctx.actor.age_years >= ctx.actor_policy.age_of_majority
}

incomplete(ctx) if {
    ctx.subject.age_band == "youth"
    ctx.subject.age_years >= ctx.subject_policy.age_of_majority
}

incomplete(ctx) if {
    ctx.actor.age_band == "adult"
    ctx.actor.age_years < ctx.actor_policy.age_of_majority
}

incomplete(ctx) if {
    ctx.subject.age_band == "adult"
    ctx.subject.age_years < ctx.subject_policy.age_of_majority
}

incomplete(ctx) if not effective_minimum(ctx.actor_policy, capability_mode(ctx.request.capability))

incomplete(ctx) if not effective_minimum(ctx.subject_policy, capability_mode(ctx.request.capability))

# -- per-side deny conditions (fixed evaluation order) ----------------------

# 4. BELOW_MINIMUM_ACCOUNT_AGE
below_minimum_account_age(ctx) if ctx.actor.age_years < ctx.actor_policy.minimum_account_age

below_minimum_account_age(ctx) if ctx.subject.age_years < ctx.subject_policy.minimum_account_age

# 5. PARENTAL_CONSENT_REQUIRED
parental_consent_required(ctx) if ctx.actor.age_years < ctx.actor_policy.parental_consent_required_below

parental_consent_required(ctx) if ctx.subject.age_years < ctx.subject_policy.parental_consent_required_below

# 6. YOUTH_NOT_LAUNCHED (per side, own policy)
youth_not_launched(ctx) if {
    ctx.actor.age_band == "youth"
    not ctx.actor_policy.youth_launch_state == "launched"
}

youth_not_launched(ctx) if {
    ctx.actor.age_band == "youth"
    not ctx.actor.cohort_key in ctx.actor_policy.allowed_cohorts
}

youth_not_launched(ctx) if {
    ctx.subject.age_band == "youth"
    not ctx.subject_policy.youth_launch_state == "launched"
}

youth_not_launched(ctx) if {
    ctx.subject.age_band == "youth"
    not ctx.subject.cohort_key in ctx.subject_policy.allowed_cohorts
}

# 7. MODE_DISABLED (per side, mapped capability mode)
actor_mode_enabled(ctx) := ctx.actor_policy.mode_rules.mode_enabled[capability_mode(ctx.request.capability)]

subject_mode_enabled(ctx) := ctx.subject_policy.mode_rules.mode_enabled[capability_mode(ctx.request.capability)]

mode_disabled(ctx) if not actor_mode_enabled(ctx)

mode_disabled(ctx) if not subject_mode_enabled(ctx)

# 8/9. age below the mapped mode's effective minimum — dating carries the
#      adult threshold, everything else the mode minimum.
below_effective_minimum(ctx) if {
    ctx.request.capability == "dating"
    ctx.actor.age_years < effective_minimum(ctx.actor_policy, "dating")
}

below_effective_minimum(ctx) if {
    ctx.request.capability == "dating"
    ctx.subject.age_years < effective_minimum(ctx.subject_policy, "dating")
}

below_effective_minimum(ctx) if {
    ctx.request.capability != "dating"
    ctx.actor.age_years < effective_minimum(ctx.actor_policy, capability_mode(ctx.request.capability))
}

below_effective_minimum(ctx) if {
    ctx.request.capability != "dating"
    ctx.subject.age_years < effective_minimum(ctx.subject_policy, capability_mode(ctx.request.capability))
}

adult_threshold_not_met(ctx) if {
    ctx.request.capability == "dating"
    below_effective_minimum(ctx)
}

mode_minimum_age_not_met(ctx) if {
    ctx.request.capability != "dating"
    below_effective_minimum(ctx)
}

# 10. AGE_ASSURANCE_REQUIRED (per side, mapped capability mode)
actor_required_assurance(ctx) := ctx.actor_policy.mode_rules.required_age_assurance_by_mode[capability_mode(ctx.request.capability)]

subject_required_assurance(ctx) := ctx.subject_policy.mode_rules.required_age_assurance_by_mode[capability_mode(ctx.request.capability)]

actor_assurance_met(ctx) if actor_required_assurance(ctx) == "self_declared"

actor_assurance_met(ctx) if {
    actor_required_assurance(ctx) == "externally_attested"
    ctx.actor.assurance_level == "externally_attested"
}

subject_assurance_met(ctx) if subject_required_assurance(ctx) == "self_declared"

subject_assurance_met(ctx) if {
    subject_required_assurance(ctx) == "externally_attested"
    ctx.subject.assurance_level == "externally_attested"
}

age_assurance_required(ctx) if not actor_assurance_met(ctx)

age_assurance_required(ctx) if not subject_assurance_met(ctx)

# 11. CROSS_COHORT_DENIED — Youth/Adult cross-partition is always denied;
#     same-band youth contact across cohorts follows the strictest of the
#     two policies' cross_cohort_contact_policy (missing/unknown → deny).
cross_partition(ctx) if {
    ctx.actor.age_band == "youth"
    ctx.subject.age_band == "adult"
}

cross_partition(ctx) if {
    ctx.actor.age_band == "adult"
    ctx.subject.age_band == "youth"
}

matrix_allows(actor, subject, policy) if policy.cross_cohort_contact_policy == "all_youth"

matrix_allows(actor, subject, policy) if {
    policy.cross_cohort_contact_policy == "adjacent_cohorts"
    abs(actor.age_years - subject.age_years) <= 1
}

matrix_allowed(ctx) if {
    matrix_allows(ctx.actor, ctx.subject, ctx.actor_policy)
    matrix_allows(ctx.actor, ctx.subject, ctx.subject_policy)
}

different_youth_cohorts(ctx) if {
    ctx.actor.age_band == "youth"
    ctx.subject.age_band == "youth"
    ctx.actor.cohort_key != ctx.subject.cohort_key
}

cross_cohort_denied(ctx) if cross_partition(ctx)

cross_cohort_denied(ctx) if {
    different_youth_cohorts(ctx)
    not matrix_allowed(ctx)
}

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

rule_holds(ctx, "CROSS_COHORT_DENIED") if cross_cohort_denied(ctx)

rule_holds(ctx, "ELIGIBILITY_INCOMPLETE") if incomplete(ctx)

deny_reasons(ctx) := [code |
    some i, code in reason_order(ctx)
    rule_holds(ctx, code)
]

reason_codes := deny_reasons(input)

obligations := ["parental_consent_required"] if parental_consent_required(input)

decision := "allow" if count(deny_reasons(input)) == 0

decision := "deny" if count(deny_reasons(input)) > 0
