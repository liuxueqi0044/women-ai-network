import { z } from 'zod';
import { idSchema } from '../ids.js';
import {
  ageBandSchema,
  assuranceLevelSchema,
  modeSchema,
  obligationSchema,
  reasonCodeSchema,
  reviewStateSchema,
} from './enums.js';

/**
 * ELG-01 public API DTOs. All bodies are `.strict()` — unknown keys are
 * rejected so a client cannot smuggle an account_id, age band, assurance
 * level or revision into a request or expect it to take effect.
 */

export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'must be an uppercase ISO 3166-1 alpha-2 country code');

export const subdivisionCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{1,3}$/, 'must be an uppercase ISO 3166-2 subdivision code');

export const jurisdictionKeySchema = z
  .string()
  .regex(
    /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/,
    'must be a country or country-subdivision jurisdiction key',
  );

/**
 * Strict ISO date-only (YYYY-MM-DD). Only the stable lower bound belongs in
 * this context-free contract. The upper bound depends on the selected
 * jurisdiction policy's timezone and therefore runs authoritatively in the
 * service after policy selection.
 */
const isoDateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar-validity check via a UTC round-trip — never for age arithmetic. */
function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const birthDateSchema = z
  .string()
  .regex(isoDateOnlyRegex, 'must be an ISO date-only YYYY-MM-DD')
  .refine(isRealCalendarDate, 'must be a real calendar date')
  .refine((value) => value >= '1900-01-01', 'must be on or after 1900-01-01');

export const idempotencyKeySchema = z.string().min(8).max(64);

export const isoDatetimeSchema = z.string().datetime({ offset: true });

/**
 * decision_id is derived from input content (sha256 → UUID v5), so it uses
 * the v5 version nibble — the shared idSchema only accepts v4.
 */
export const decisionIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'must be a lowercase UUID v5',
  );

/** Sentinel for an open-ended policy interval, kept an ISO datetime so clients can parse it. */
export const OPEN_ENDED = '9999-12-31T23:59:59Z';

export const policyHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest');

// ---------------------------------------------------------------------------
// PUT /v1/eligibility/jurisdiction
// ---------------------------------------------------------------------------

export const jurisdictionDeclarationRequestSchema = z
  .object({
    country_code: countryCodeSchema,
    subdivision_code: subdivisionCodeSchema.optional(),
    /** Fixed: the API only accepts self-declared jurisdiction claims today. */
    source: z.literal('self_declared').optional(),
  })
  .strict();

export type JurisdictionDeclarationRequest = z.infer<typeof jurisdictionDeclarationRequestSchema>;

export const jurisdictionDeclarationResponseSchema = z
  .object({
    declaration_id: idSchema,
    country_code: countryCodeSchema,
    subdivision_code: subdivisionCodeSchema.optional(),
    review_state: reviewStateSchema,
    effective_from: isoDatetimeSchema,
  })
  .strict();

export type JurisdictionDeclarationResponse = z.infer<typeof jurisdictionDeclarationResponseSchema>;

// ---------------------------------------------------------------------------
// PUT /v1/eligibility/age-declaration
// ---------------------------------------------------------------------------

export const ageDeclarationRequestSchema = z.object({ birth_date: birthDateSchema }).strict();

export type AgeDeclarationRequest = z.infer<typeof ageDeclarationRequestSchema>;

/** Never echoes the birthday — derived facts only. */
export const ageDeclarationResponseSchema = z
  .object({
    credential_id: idSchema,
    age_band: ageBandSchema,
    cohort_key: z.string().min(1).max(32),
    assurance_level: assuranceLevelSchema,
    valid_until: isoDatetimeSchema,
  })
  .strict();

export type AgeDeclarationResponse = z.infer<typeof ageDeclarationResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/eligibility/status
// ---------------------------------------------------------------------------

export const jurisdictionStatusSchema = z
  .object({
    declaration_id: idSchema,
    country_code: countryCodeSchema,
    subdivision_code: subdivisionCodeSchema.optional(),
    review_state: reviewStateSchema,
    effective_from: isoDatetimeSchema,
  })
  .strict();

export const activePolicyStatusSchema = z
  .object({
    policy_id: idSchema,
    jurisdiction_key: jurisdictionKeySchema,
    revision: z.number().int().min(1),
    effective_from: isoDatetimeSchema,
    effective_until: isoDatetimeSchema,
    timezone: z.string().min(1).max(64),
  })
  .strict();

export const ageCredentialStatusSchema = z
  .object({
    credential_id: idSchema,
    age_band: ageBandSchema,
    cohort_key: z.string().min(1).max(32),
    assurance_level: assuranceLevelSchema,
    valid_from: isoDatetimeSchema,
    valid_until: isoDatetimeSchema,
  })
  .strict();

export const eligibilityStatusResponseSchema = z
  .object({
    jurisdiction: jurisdictionStatusSchema.nullable(),
    active_policy: activePolicyStatusSchema.nullable(),
    age: ageCredentialStatusSchema.nullable(),
  })
  .strict();

export type EligibilityStatusResponse = z.infer<typeof eligibilityStatusResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/eligibility/mode-evaluations
// ---------------------------------------------------------------------------

export const modeEvaluationRequestSchema = z
  .object({
    mode: modeSchema,
    /** Defaults to now at the service layer; must not be a future-replay for the same key. */
    effective_at: isoDatetimeSchema.optional(),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .strict();

export type ModeEvaluationRequest = z.infer<typeof modeEvaluationRequestSchema>;

export const modeEvaluationResponseSchema = z
  .object({
    decision_id: decisionIdSchema,
    scope: z.literal('age_and_jurisdiction'),
    decision: z.enum(['allow', 'deny']),
    mode: modeSchema,
    age_band: ageBandSchema,
    cohort_key: z.string().min(1).max(32),
    assurance_level: assuranceLevelSchema,
    reason_codes: z.array(reasonCodeSchema),
    obligations: z.array(obligationSchema),
    policy: z
      .object({
        policy_id: idSchema,
        revision: z.number().int().min(1),
        policy_hash: policyHashSchema,
      })
      .strict(),
    credential: z
      .object({
        credential_id: idSchema,
        assurance_level: assuranceLevelSchema,
      })
      .strict(),
    evaluated_at: isoDatetimeSchema,
    valid_until: isoDatetimeSchema,
  })
  .strict();

export type ModeEvaluationResponse = z.infer<typeof modeEvaluationResponseSchema>;
