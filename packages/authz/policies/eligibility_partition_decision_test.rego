# ELG-01 partition decision tests — table-driven policy matrix (task book §10).

package eligibility.partition_decision_test

import rego.v1

CAPABILITIES := {"discover", "introduce", "direct_message", "event_visibility", "dating"}

part_base_policy := {
    "policy_id": "22222222-2222-4222-8222-222222222222",
    "revision": 1,
    "minimum_account_age": 13,
    "age_of_majority": 18,
    "digital_consent_age": 16,
    "parental_consent_required_below": 16,
    "youth_launch_state": "launched",
    "allowed_cohorts": ["youth_13", "youth_14", "youth_15", "youth_16", "youth_17"],
    "cross_cohort_contact_policy": "same_cohort_only",
    "mode_rules": {
        "mode_enabled": {"friends": true, "activities": true, "professional": true, "circles": true, "events": true, "dating": true},
        "platform_minimum_age_by_mode": {"friends": 13, "activities": 13, "professional": 13, "circles": 13, "events": 13, "dating": 13},
        "mode_minimum_age": {"friends": 0, "activities": 0, "professional": 0, "circles": 0, "events": 0, "dating": 0},
        "required_age_assurance_by_mode": {"friends": "self_declared", "activities": "self_declared", "professional": "self_declared", "circles": "self_declared", "events": "self_declared", "dating": "self_declared"},
    },
}

part_subject(age, band, cohort, assurance) := {
    "age_years": age,
    "age_band": band,
    "cohort_key": cohort,
    "assurance_level": assurance,
}

part_doc(actor, subject_doc, actor_policy, subject_policy, capability) := {
    "actor_policy": actor_policy,
    "subject_policy": subject_policy,
    "actor": actor,
    "subject": subject_doc,
    "request": {"capability": capability, "effective_at": "2026-08-17T00:00:00Z"},
}

# -- adult/adult and same-band basics ----------------------------------------

test_adult_adult_discover_allowed if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(19, "adult", "adult", "self_declared"), part_subject(22, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "discover")
    d.decision == "allow"
    d.reason_codes == []
}

test_all_five_capabilities_adult_adult_allowed if {
    count([cap |
        cap := CAPABILITIES[_]
        d := data.eligibility.partition_decision with input as part_doc(part_subject(22, "adult", "adult", "self_declared"), part_subject(22, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, cap)
        d.decision != "allow"
    ]) == 0
}

test_youth_same_cohort_allowed if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(16, "youth", "youth_16", "self_declared"), part_base_policy, part_base_policy, "discover")
    d.decision == "allow"
}

# -- 11. CROSS_COHORT_DENIED ------------------------------------------------

test_cross_partition_all_capabilities_denied if {
    count([cap |
        cap := CAPABILITIES[_]
        d := data.eligibility.partition_decision with input as part_doc(part_subject(17, "youth", "youth_17", "self_declared"), part_subject(19, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, cap)
        d.decision != "deny"
        d.reason_codes != ["CROSS_COHORT_DENIED"]
    ]) == 0
}

test_cross_partition_adult_youth_denied if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(19, "adult", "adult", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), part_base_policy, part_base_policy, "introduce")
    d.decision == "deny"
    d.reason_codes == ["CROSS_COHORT_DENIED"]
}

test_different_youth_cohorts_same_cohort_only_denied if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), part_base_policy, part_base_policy, "discover")
    d.decision == "deny"
    d.reason_codes == ["CROSS_COHORT_DENIED"]
}

adjacent_policy := object.union(part_base_policy, {"cross_cohort_contact_policy": "adjacent_cohorts"})

test_adjacent_youth_cohorts_allowed if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), adjacent_policy, adjacent_policy, "discover")
    d.decision == "allow"
}

test_non_adjacent_youth_cohorts_denied if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(14, "youth", "youth_14", "self_declared"), adjacent_policy, adjacent_policy, "discover")
    d.decision == "deny"
    d.reason_codes == ["PARENTAL_CONSENT_REQUIRED", "CROSS_COHORT_DENIED"]
}

test_mixed_policies_strictest_wins if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), adjacent_policy, part_base_policy, "discover")
    d.decision == "deny"
    d.reason_codes == ["CROSS_COHORT_DENIED"]
}

all_youth_policy := object.union(part_base_policy, {"cross_cohort_contact_policy": "all_youth"})

test_all_youth_matrix_allows_any_youth_pair if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), all_youth_policy, all_youth_policy, "discover")
    d.decision == "allow"
}

# -- dating hard gate (two-party) -------------------------------------------

test_dating_both_adult_allowed if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(19, "adult", "adult", "self_declared"), part_subject(22, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "dating")
    d.decision == "allow"
}

test_dating_both_youth_denied_adult_threshold if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(16, "youth", "youth_16", "self_declared"), part_base_policy, part_base_policy, "dating")
    d.decision == "deny"
    d.reason_codes == ["ADULT_THRESHOLD_NOT_MET"]
}

dating_min_21_policy := object.union(part_base_policy, {"mode_rules": object.union(part_base_policy.mode_rules, {"mode_minimum_age": object.union({"friends": 0, "activities": 0, "professional": 0, "circles": 0, "events": 0}, {"dating": 21})})})

test_dating_both_adult_one_side_below_mode_minimum if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(18, "adult", "adult", "self_declared"), part_subject(22, "adult", "adult", "self_declared"), dating_min_21_policy, dating_min_21_policy, "dating")
    d.decision == "deny"
    d.reason_codes == ["ADULT_THRESHOLD_NOT_MET"]
}

dating_attested_part_policy := object.union(part_base_policy, {"mode_rules": object.union(part_base_policy.mode_rules, {"required_age_assurance_by_mode": object.union({"friends": "self_declared", "activities": "self_declared", "professional": "self_declared", "circles": "self_declared", "events": "self_declared"}, {"dating": "externally_attested"})})})

test_dating_one_side_missing_assurance if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(22, "adult", "adult", "self_declared"), part_subject(22, "adult", "adult", "externally_attested"), dating_attested_part_policy, dating_attested_part_policy, "dating")
    d.decision == "deny"
    d.reason_codes == ["AGE_ASSURANCE_REQUIRED"]
}

# -- capability → mode mapping ----------------------------------------------

events_min_18_policy := object.union(part_base_policy, {"mode_rules": object.union(part_base_policy.mode_rules, {"mode_minimum_age": object.union({"friends": 0, "activities": 0, "professional": 0, "circles": 0, "dating": 0}, {"events": 18})})})

test_event_visibility_applies_events_rules if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(17, "youth", "youth_17", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), events_min_18_policy, events_min_18_policy, "event_visibility")
    d.decision == "deny"
    d.reason_codes == ["MODE_MINIMUM_AGE_NOT_MET"]
}

test_direct_message_applies_friends_rules if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(17, "youth", "youth_17", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), events_min_18_policy, events_min_18_policy, "direct_message")
    d.decision == "allow"
}

test_circles_applies_circles_rules if {
    circles_min_18 := object.union(part_base_policy, {"mode_rules": object.union(part_base_policy.mode_rules, {"mode_minimum_age": object.union({"friends": 0, "activities": 0, "professional": 0, "events": 0, "dating": 0}, {"circles": 18})})})
    d := data.eligibility.partition_decision with input as part_doc(part_subject(17, "youth", "youth_17", "self_declared"), part_subject(17, "youth", "youth_17", "self_declared"), circles_min_18, circles_min_18, "circles")
    d.decision == "deny"
    d.reason_codes == ["MODE_MINIMUM_AGE_NOT_MET"]
}

# -- per-side gates ---------------------------------------------------------

test_partition_below_minimum_denied if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(12, "below_minimum", "below_minimum", "self_declared"), part_subject(19, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "discover")
    d.decision == "deny"
    d.reason_codes == ["BELOW_MINIMUM_ACCOUNT_AGE", "PARENTAL_CONSENT_REQUIRED", "MODE_MINIMUM_AGE_NOT_MET"]
}

test_partition_youth_not_launched_denied if {
    not_launched := object.union(part_base_policy, {"youth_launch_state": "not_launched"})
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(16, "youth", "youth_16", "self_declared"), not_launched, part_base_policy, "discover")
    d.decision == "deny"
    d.reason_codes == ["YOUTH_NOT_LAUNCHED"]
}

test_partition_missing_input_incomplete if {
    d := data.eligibility.partition_decision with input as {"actor_policy": part_base_policy, "subject_policy": part_base_policy, "actor": part_subject(16, "youth", "youth_16", "self_declared"), "request": {"capability": "discover", "effective_at": "2026-08-17T00:00:00Z"}}
    d.decision == "deny"
    d.reason_codes == ["ELIGIBILITY_INCOMPLETE"]
}

# -- actor/subject band-consistency invariants ------------------------------

test_actor_below_minimum_band_inconsistent_incomplete if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(13, "below_minimum", "below_minimum", "self_declared"), part_subject(19, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "discover")
    d.decision == "deny"
    "ELIGIBILITY_INCOMPLETE" in d.reason_codes
}

test_actor_youth_band_inconsistent_incomplete if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(19, "youth", "youth_19", "self_declared"), part_subject(19, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "discover")
    d.decision == "deny"
    "ELIGIBILITY_INCOMPLETE" in d.reason_codes
}

test_actor_adult_band_inconsistent_incomplete if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(17, "adult", "adult", "self_declared"), part_subject(19, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "discover")
    d.decision == "deny"
    d.reason_codes == ["ELIGIBILITY_INCOMPLETE"]
}

# -- per-side youth launch gates --------------------------------------------

test_partition_subject_not_launched_denied if {
    not_launched := object.union(part_base_policy, {"youth_launch_state": "not_launched"})
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(16, "youth", "youth_16", "self_declared"), part_base_policy, not_launched, "discover")
    d.decision == "deny"
    d.reason_codes == ["YOUTH_NOT_LAUNCHED"]
}

test_partition_actor_cohort_excluded_denied if {
    excluded := object.union(part_base_policy, {"allowed_cohorts": ["youth_13", "youth_14", "youth_15", "youth_17"]})
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(16, "youth", "youth_16", "self_declared"), excluded, part_base_policy, "discover")
    d.decision == "deny"
    d.reason_codes == ["YOUTH_NOT_LAUNCHED"]
}

test_partition_subject_cohort_excluded_denied if {
    excluded := object.union(part_base_policy, {"allowed_cohorts": ["youth_13", "youth_14", "youth_15", "youth_17"]})
    d := data.eligibility.partition_decision with input as part_doc(part_subject(16, "youth", "youth_16", "self_declared"), part_subject(16, "youth", "youth_16", "self_declared"), part_base_policy, excluded, "discover")
    d.decision == "deny"
    d.reason_codes == ["YOUTH_NOT_LAUNCHED"]
}

# -- dating with one below-threshold side -----------------------------------

test_dating_cross_partition_adult_threshold if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(17, "youth", "youth_17", "self_declared"), part_subject(19, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "dating")
    d.decision == "deny"
    d.reason_codes == ["ADULT_THRESHOLD_NOT_MET", "CROSS_COHORT_DENIED"]
}

test_partition_unknown_capability_incomplete if {
    d := data.eligibility.partition_decision with input as part_doc(part_subject(19, "adult", "adult", "self_declared"), part_subject(22, "adult", "adult", "self_declared"), part_base_policy, part_base_policy, "matchmaking")
    d.decision == "deny"
    "ELIGIBILITY_INCOMPLETE" in d.reason_codes
}
