import { z } from 'zod';

/**
 * ELG-01 fixed enums. Every value here is a stable public surface: it is
 * mirrored into the Rego policy, the DB CHECK constraints and the API
 * response DTOs — never rename, reorder or remove a published value.
 */

/** The six relationship modes evaluated by the eligibility engine. */
export const modeSchema = z.enum([
  'friends',
  'activities',
  'professional',
  'circles',
  'events',
  'dating',
]);

export type ModeCode = z.infer<typeof modeSchema>;
export const modeCodes = modeSchema.options;

/** Fixed age bands — the only four values ever stored or returned. */
export const ageBandSchema = z.enum(['unknown', 'below_minimum', 'youth', 'adult']);
export type AgeBand = z.infer<typeof ageBandSchema>;

export const assuranceLevelSchema = z.enum(['self_declared', 'externally_attested']);
export type AssuranceLevel = z.infer<typeof assuranceLevelSchema>;

/** Who produced a credential. `verification_module` is reserved for VER-01. */
export const issuerTypeSchema = z.enum(['eligibility_self_declaration', 'verification_module']);
export type IssuerType = z.infer<typeof issuerTypeSchema>;

/** Fixed five social capabilities for two-party partition decisions. */
export const capabilitySchema = z.enum([
  'discover',
  'introduce',
  'direct_message',
  /** A private-circle relationship boundary, distinct from event discovery. */
  'circles',
  'event_visibility',
  'dating',
]);
export type CapabilityCode = z.infer<typeof capabilitySchema>;
export const capabilityCodes = capabilitySchema.options;

/**
 * Obligations that an allow decision may impose. Closed set — new values are
 * additive contract changes, never silently extended by policy content.
 */
export const obligationSchema = z.enum(['parental_consent_required']);
export type Obligation = z.infer<typeof obligationSchema>;
export const obligationCodes = obligationSchema.options;

/**
 * The fixed, ordered reason-code set (14). The order is the documented
 * Rego evaluation order — first applicable code wins. Never reorder.
 */
export const reasonCodeSchema = z.enum([
  'ELIGIBILITY_INCOMPLETE',
  'NO_ACTIVE_JURISDICTION_POLICY',
  'JURISDICTION_REVIEW_REQUIRED',
  'BELOW_MINIMUM_ACCOUNT_AGE',
  'PARENTAL_CONSENT_REQUIRED',
  'YOUTH_NOT_LAUNCHED',
  'MODE_DISABLED',
  'MODE_MINIMUM_AGE_NOT_MET',
  'ADULT_THRESHOLD_NOT_MET',
  'AGE_ASSURANCE_REQUIRED',
  'CROSS_COHORT_DENIED',
  'POLICY_ENGINE_UNAVAILABLE',
  'POLICY_OUTPUT_INVALID',
  'ACCOUNT_NOT_ENABLED',
]);

export type ReasonCode = z.infer<typeof reasonCodeSchema>;
export const reasonCodes = reasonCodeSchema.options;

/** Review state of a jurisdiction declaration. */
export const reviewStateSchema = z.enum(['accepted', 'conflict_review_required']);
export type ReviewState = z.infer<typeof reviewStateSchema>;

/** How a jurisdiction declaration was obtained. */
export const declarationSourceSchema = z.enum(['self_declared', 'reviewed']);
export type DeclarationSource = z.infer<typeof declarationSourceSchema>;

/** Youth launch state stored on a policy. */
export const youthLaunchStateSchema = z.enum(['launched', 'not_launched']);
export type YouthLaunchState = z.infer<typeof youthLaunchStateSchema>;

/**
 * The eligibility engine's snapshot schema version (task book §4.4
 * `engine_version`). Bump when the decision-snapshot shape changes — old
 * snapshots stay valid evidence of what was evaluated under an older engine.
 */
export const ELIGIBILITY_ENGINE_VERSION = 1;
