import { z } from 'zod';
import { idSchema } from '../ids.js';
import {
  ageBandSchema,
  assuranceLevelSchema,
  capabilitySchema,
  modeCodes,
  modeSchema,
  obligationSchema,
  reasonCodeSchema,
  youthLaunchStateSchema,
} from './enums.js';

/**
 * ELG-01 OPA input/output contract. Inputs are derived, PII-free documents:
 * account IDs, birthdays, emails, IPs, devices and names are forbidden.
 * Outputs are parsed with `.strict()` and fail closed on anything unknown.
 */

const ageThresholdSchema = z.number().int().min(0).max(150);
const ageYearsSchema = z.number().int().min(0).max(150);

/**
 * Every mode map must define all six modes explicitly — a policy document
 * with a missing mode cannot be evaluated and must not be guessed at by
 * JavaScript truthiness.
 */
function completeModeRules<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .record(modeSchema, valueSchema)
    .refine(
      (rules) => modeCodes.every((code) => rules[code] !== undefined),
      'must define explicit rules for all six modes',
    );
}

/** How same-band youth cohorts may interact (partition decisions). */
export const crossCohortContactPolicySchema = z.enum([
  'same_cohort_only',
  'adjacent_cohorts',
  'all_youth',
]);
export type CrossCohortContactPolicy = z.infer<typeof crossCohortContactPolicySchema>;

/** Non-PII policy document sent to OPA (derived from DB content at load time). */
export const policyDocumentSchema = z
  .object({
    policy_id: idSchema,
    revision: z.number().int().min(1),
    minimum_account_age: ageThresholdSchema,
    age_of_majority: ageThresholdSchema,
    digital_consent_age: ageThresholdSchema,
    parental_consent_required_below: ageThresholdSchema,
    youth_launch_state: youthLaunchStateSchema,
    allowed_cohorts: z.array(z.string().min(1).max(32)),
    cross_cohort_contact_policy: crossCohortContactPolicySchema,
    mode_rules: z
      .object({
        mode_enabled: completeModeRules(z.boolean()),
        platform_minimum_age_by_mode: completeModeRules(ageThresholdSchema),
        mode_minimum_age: completeModeRules(ageThresholdSchema),
        required_age_assurance_by_mode: completeModeRules(assuranceLevelSchema),
      })
      .strict(),
  })
  .strict();

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

/** Governance metadata required before a policy may be approved.  This is
 * intentionally kept outside the OPA document: it is publication evidence,
 * not a decision input or legal text. */
export const policyGovernanceSchema = z
  .object({
    location_precision_policy: z.enum(['country_only', 'country_and_subdivision']),
    profiling_policy: z.enum(['derived_facts_only', 'prohibited']),
    retention_policy: z.string().min(1).max(128),
    legal_basis_refs: z.array(z.string().min(1).max(256)).min(1).max(32),
    reviewed_by: z.string().min(1).max(128),
    reviewed_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type PolicyGovernance = z.infer<typeof policyGovernanceSchema>;

/** Non-PII subject (derived age facts only, never the birthday itself). */
export const subjectDocumentSchema = z
  .object({
    age_years: ageYearsSchema,
    age_band: ageBandSchema,
    cohort_key: z.string().min(1).max(32),
    assurance_level: assuranceLevelSchema,
  })
  .strict();

export type SubjectDocument = z.infer<typeof subjectDocumentSchema>;

/** Single-subject mode evaluation input (`POST /v1/data/eligibility/mode_decision`). */
export const modeDecisionInputSchema = z
  .object({
    policy: policyDocumentSchema,
    subject: subjectDocumentSchema,
    request: z
      .object({
        mode: modeSchema,
        effective_at: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export type ModeDecisionInput = z.infer<typeof modeDecisionInputSchema>;

/** Two-party partition evaluation input (`POST /v1/data/eligibility/partition_decision`). */
export const partitionDecisionInputSchema = z
  .object({
    actor_policy: policyDocumentSchema,
    subject_policy: policyDocumentSchema,
    actor: subjectDocumentSchema,
    subject: subjectDocumentSchema,
    request: z
      .object({
        capability: capabilitySchema,
        effective_at: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export type PartitionDecisionInput = z.infer<typeof partitionDecisionInputSchema>;

/**
 * Output contract for both decision endpoints. `reason_codes` and
 * `obligations` are whitelist-constrained — an unknown code invalidates the
 * whole result (the adapter converts that into a fail-closed deny).
 */
export const decisionOutputSchema = z
  .object({
    decision: z.enum(['allow', 'deny']),
    reason_codes: z.array(reasonCodeSchema),
    obligations: z.array(obligationSchema),
  })
  .strict();

export type DecisionOutput = z.infer<typeof decisionOutputSchema>;
