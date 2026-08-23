# ELG-01 Rego unit tests — table-driven policy matrix (task book §10).
# Run via: opa test ./policies -v --fail-on-empty --coverage --format=json
# (scripts/elg-policy-test.mjs, pinned image openpolicyagent/opa:1.17.0-static).

package eligibility.mode_decision_test

import rego.v1

MODES := {"friends", "activities", "professional", "circles", "events", "dating"}

all_true := {"friends": true, "activities": true, "professional": true, "circles": true, "events": true, "dating": true}
all_13 := {"friends": 13, "activities": 13, "professional": 13, "circles": 13, "events": 13, "dating": 13}
all_0 := {"friends": 0, "activities": 0, "professional": 0, "circles": 0, "events": 0, "dating": 0}
all_self := {"friends": "self_declared", "activities": "self_declared", "professional": "self_declared", "circles": "self_declared", "events": "self_declared", "dating": "self_declared"}

# Synthetic policy fixture — never a real jurisdiction's law (task book §4.2.6).
base_policy := {
    "policy_id": "11111111-1111-4111-8111-111111111111",
    "revision": 1,
    "minimum_account_age": 13,
    "age_of_majority": 18,
    "digital_consent_age": 16,
    "parental_consent_required_below": 16,
    "youth_launch_state": "launched",
    "allowed_cohorts": ["youth_13", "youth_14", "youth_15", "youth_16", "youth_17"],
    "cross_cohort_contact_policy": "same_cohort_only",
    "mode_rules": {
        "mode_enabled": all_true,
        "platform_minimum_age_by_mode": all_13,
        "mode_minimum_age": all_0,
        "required_age_assurance_by_mode": all_self,
    },
}

subject(age, band, cohort, assurance) := {
    "age_years": age,
    "age_band": band,
    "cohort_key": cohort,
    "assurance_level": assurance,
}

adult22 := subject(22, "adult", "adult", "self_declared")
adult18 := subject(18, "adult", "adult", "self_declared")

request(mode) := {"mode": mode, "effective_at": "2026-08-17T00:00:00Z"}

mode_doc(policy, subj, mode) := {"policy": policy, "subject": subj, "request": request(mode)}

# -- base allow paths -------------------------------------------------------

test_adult_18_friends_allowed if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, adult18, "friends")
    d.decision == "allow"
    d.reason_codes == []
    d.obligations == []
}

test_all_six_modes_adult_allowed if {
    count([mode |
        mode := MODES[_]
        d := data.eligibility.mode_decision with input as mode_doc(base_policy, adult22, mode)
        d.decision != "allow"
    ]) == 0
}

# 13 is the exact account minimum, but the subject is still below the
# parental-consent threshold (16) — the consent gate governs, not allow.
test_youth_at_exact_minimum_requires_consent if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(13, "youth", "youth_13", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["PARENTAL_CONSENT_REQUIRED"]
}

test_youth_17_friends_allowed if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(17, "youth", "youth_17", "self_declared"), "friends")
    d.decision == "allow"
}

# -- 4. BELOW_MINIMUM_ACCOUNT_AGE -------------------------------------------

test_below_minimum_account_age if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(12, "below_minimum", "below_minimum", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["BELOW_MINIMUM_ACCOUNT_AGE", "PARENTAL_CONSENT_REQUIRED", "MODE_MINIMUM_AGE_NOT_MET"]
}

test_at_minimum_not_below if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(13, "youth", "youth_13", "self_declared"), "dating")
    d.reason_codes[_] != "BELOW_MINIMUM_ACCOUNT_AGE"
}

# -- 5. PARENTAL_CONSENT_REQUIRED -------------------------------------------

test_parental_consent_required if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(15, "youth", "youth_15", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["PARENTAL_CONSENT_REQUIRED"]
    d.obligations == ["parental_consent_required"]
}

test_parental_consent_at_threshold_not_required if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(16, "youth", "youth_16", "self_declared"), "friends")
    d.decision == "allow"
    d.obligations == []
}

# -- 6. YOUTH_NOT_LAUNCHED --------------------------------------------------

not_launched_policy := object.union(base_policy, {"youth_launch_state": "not_launched"})

test_youth_not_launched if {
    d := data.eligibility.mode_decision with input as mode_doc(not_launched_policy, subject(16, "youth", "youth_16", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["YOUTH_NOT_LAUNCHED"]
}

test_youth_not_launched_adult_still_allowed if {
    d := data.eligibility.mode_decision with input as mode_doc(not_launched_policy, subject(19, "adult", "adult", "self_declared"), "friends")
    d.decision == "allow"
}

excluded_cohort_policy := object.union(base_policy, {"allowed_cohorts": ["youth_13", "youth_14", "youth_15", "youth_16"]})

test_youth_cohort_excluded if {
    d := data.eligibility.mode_decision with input as mode_doc(excluded_cohort_policy, subject(17, "youth", "youth_17", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["YOUTH_NOT_LAUNCHED"]
}

# -- 7. MODE_DISABLED -------------------------------------------------------

dating_disabled_policy := object.union(base_policy, {"mode_rules": object.union(base_policy.mode_rules, {"mode_enabled": object.union(all_true, {"dating": false})})})

test_mode_disabled if {
    d := data.eligibility.mode_decision with input as mode_doc(dating_disabled_policy, adult22, "dating")
    d.decision == "deny"
    d.reason_codes == ["MODE_DISABLED"]
}

# object.union deep-merges in OPA 1.x, so mode_rules must be dropped from the
# base policy first — otherwise the base mode_enabled leaks back in.
missing_switch_mode_rules := {
    "mode_enabled": {"friends": true, "activities": true, "professional": true, "circles": true, "events": true},
    "platform_minimum_age_by_mode": all_13,
    "mode_minimum_age": all_0,
    "required_age_assurance_by_mode": all_self,
}

missing_dating_switch_policy := object.union(object.remove(base_policy, ["mode_rules"]), {"mode_rules": missing_switch_mode_rules})

test_missing_mode_switch_is_disabled if {
    d := data.eligibility.mode_decision with input as mode_doc(missing_dating_switch_policy, adult22, "dating")
    d.decision == "deny"
    d.reason_codes == ["MODE_DISABLED"]
}

# -- 8. MODE_MINIMUM_AGE_NOT_MET --------------------------------------------

friends_min_18_policy := object.union(base_policy, {"mode_rules": object.union(base_policy.mode_rules, {"mode_minimum_age": object.union(all_0, {"friends": 18})})})

test_mode_minimum_age_not_met if {
    d := data.eligibility.mode_decision with input as mode_doc(friends_min_18_policy, subject(17, "youth", "youth_17", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["MODE_MINIMUM_AGE_NOT_MET"]
}

test_mode_minimum_age_met_at_exact_threshold if {
    d := data.eligibility.mode_decision with input as mode_doc(friends_min_18_policy, adult18, "friends")
    d.decision == "allow"
}

# -- 9. ADULT_THRESHOLD_NOT_MET (dating hard gate) --------------------------

test_dating_17_denied_adult_threshold if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(17, "youth", "youth_17", "self_declared"), "dating")
    d.decision == "deny"
    d.reason_codes == ["ADULT_THRESHOLD_NOT_MET"]
}

test_dating_18_allowed if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, adult18, "dating")
    d.decision == "allow"
}

majority_21_policy := object.union(base_policy, {"age_of_majority": 21, "allowed_cohorts": ["youth_13", "youth_14", "youth_15", "youth_16", "youth_17", "youth_18", "youth_19", "youth_20"]})

test_dating_majority_21_age_20_denied if {
    d := data.eligibility.mode_decision with input as mode_doc(majority_21_policy, subject(20, "youth", "youth_20", "self_declared"), "dating")
    d.decision == "deny"
    d.reason_codes == ["ADULT_THRESHOLD_NOT_MET"]
}

test_dating_majority_21_age_21_allowed if {
    d := data.eligibility.mode_decision with input as mode_doc(majority_21_policy, subject(21, "adult", "adult", "self_declared"), "dating")
    d.decision == "allow"
}

# -- 10. AGE_ASSURANCE_REQUIRED ---------------------------------------------

dating_attested_policy := object.union(base_policy, {"mode_rules": object.union(base_policy.mode_rules, {"required_age_assurance_by_mode": object.union(all_self, {"dating": "externally_attested"})})})

test_dating_assurance_self_declared_denied if {
    d := data.eligibility.mode_decision with input as mode_doc(dating_attested_policy, adult22, "dating")
    d.decision == "deny"
    d.reason_codes == ["AGE_ASSURANCE_REQUIRED"]
}

test_dating_assurance_externally_attested_allowed if {
    d := data.eligibility.mode_decision with input as mode_doc(dating_attested_policy, subject(22, "adult", "adult", "externally_attested"), "dating")
    d.decision == "allow"
}

test_self_declared_meets_self_declared_requirement if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, adult22, "dating")
    not "AGE_ASSURANCE_REQUIRED" in d.reason_codes
}

# -- stable fixed-order reason list -----------------------------------------

test_multi_reason_fixed_order if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(15, "youth", "youth_15", "self_declared"), "dating")
    d.decision == "deny"
    d.reason_codes == ["PARENTAL_CONSENT_REQUIRED", "ADULT_THRESHOLD_NOT_MET"]
}

test_multi_reason_below_minimum_ordering if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(12, "below_minimum", "below_minimum", "self_declared"), "dating")
    d.decision == "deny"
    d.reason_codes == ["BELOW_MINIMUM_ACCOUNT_AGE", "PARENTAL_CONSENT_REQUIRED", "ADULT_THRESHOLD_NOT_MET"]
}

# -- fail closed: incomplete input ------------------------------------------

test_missing_subject_incomplete if {
    d := data.eligibility.mode_decision with input as {"policy": base_policy, "request": request("friends")}
    d.decision == "deny"
    d.reason_codes == ["ELIGIBILITY_INCOMPLETE"]
}

test_missing_policy_incomplete if {
    d := data.eligibility.mode_decision with input as {"subject": adult22, "request": request("friends")}
    d.decision == "deny"
    "ELIGIBILITY_INCOMPLETE" in d.reason_codes
}

test_missing_mode_rule_incomplete if {
    partial_rules := {"mode_enabled": all_true, "platform_minimum_age_by_mode": {"friends": 13}, "mode_minimum_age": all_0, "required_age_assurance_by_mode": all_self}
    partial_policy := object.union(object.remove(base_policy, ["mode_rules"]), {"mode_rules": partial_rules})
    d := data.eligibility.mode_decision with input as mode_doc(partial_policy, adult22, "dating")
    d.decision == "deny"
    d.reason_codes == ["ELIGIBILITY_INCOMPLETE"]
}

test_missing_subject_field_incomplete if {
    d := data.eligibility.mode_decision with input as {"policy": base_policy, "subject": {"age_band": "adult", "cohort_key": "adult", "assurance_level": "self_declared"}, "request": request("friends")}
    d.decision == "deny"
    d.reason_codes == ["ELIGIBILITY_INCOMPLETE"]
}

# -- fail closed: inconsistent derived document -----------------------------

test_inconsistent_youth_band_incomplete if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(19, "youth", "youth_19", "self_declared"), "friends")
    d.decision == "deny"
    "ELIGIBILITY_INCOMPLETE" in d.reason_codes
}

test_unknown_band_incomplete if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(17, "unknown", "youth_17", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["ELIGIBILITY_INCOMPLETE"]
}

test_below_minimum_band_inconsistent_incomplete if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(13, "below_minimum", "below_minimum", "self_declared"), "friends")
    d.decision == "deny"
    "ELIGIBILITY_INCOMPLETE" in d.reason_codes
}

test_adult_band_inconsistent_incomplete if {
    d := data.eligibility.mode_decision with input as mode_doc(base_policy, subject(17, "adult", "adult", "self_declared"), "friends")
    d.decision == "deny"
    d.reason_codes == ["ELIGIBILITY_INCOMPLETE"]
}

# ---------------------------------------------------------------------------
# Partition decisions
# ---------------------------------------------------------------------------
