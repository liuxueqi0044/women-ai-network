import { z } from 'zod';
import {
  consentRetentionSchema,
  onboardingCriterionSchema,
  onboardingModeSchema,
  onboardingModeCodes,
  onboardingPurposeSchema,
  onboardingStrengthSchema,
  onboardingSessionStateSchema,
  proposalStateSchema,
} from './enums.js';

const uuid = z.string().uuid();
const version = z.number().int().nonnegative();
const answerText = z.string().trim().min(1).max(5000);

export const onboardingPreferenceSchema = z
  .object({
    mode: onboardingModeSchema,
    criterion: onboardingCriterionSchema,
    strength: onboardingStrengthSchema,
    value: z.string().trim().min(1).max(160),
    deal_breaker: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.strength === 'does_not_matter' && value.deal_breaker) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'does_not_matter cannot be a deal breaker',
      });
    }
  });
export type OnboardingPreference = z.infer<typeof onboardingPreferenceSchema>;
export const onboardingProvenanceSchema = z.enum([
  'member_text_extraction',
  'local_rules',
  'provider_model',
]);
export const onboardingExtractionSchema = z
  .object({
    confidence: z.number().finite().min(0).max(1),
    provenance: onboardingProvenanceSchema,
    preferences: z.array(onboardingPreferenceSchema).max(64),
  })
  .strict();

export const onboardingCreateSchema = z
  .object({
    purpose: onboardingPurposeSchema,
    modes: z.array(onboardingModeSchema).min(1).max(onboardingModeCodes.length),
    dating_enabled: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.modes).size !== value.modes.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'modes must be unique' });
    const dating = value.modes.includes('dating');
    if (dating !== value.dating_enabled)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Dating requires a matching explicit enablement',
      });
  });
export type OnboardingCreate = z.infer<typeof onboardingCreateSchema>;

export const onboardingAnswerSchema = z
  .object({
    purpose: onboardingPurposeSchema,
    mode: onboardingModeSchema,
    revision: version,
    text: answerText,
  })
  .strict();
export type OnboardingAnswer = z.infer<typeof onboardingAnswerSchema>;
export const onboardingExtractSchema = z
  .object({
    purpose: onboardingPurposeSchema,
    mode: onboardingModeSchema,
    session_id: uuid,
    provider: z.string().trim().min(1).max(64),
    consent_id: uuid,
    expected_answer_revision: version,
    modes_version: z.number().int().positive(),
  })
  .strict();
export type OnboardingExtract = z.infer<typeof onboardingExtractSchema>;
export const onboardingConfirmSchema = z
  .object({
    purpose: onboardingPurposeSchema,
    session_id: uuid,
    proposal_id: uuid,
    expected_version: version,
    expected_answer_revision: version,
    modes_version: z.number().int().positive(),
    modes: z.array(onboardingModeSchema).min(1).max(onboardingModeCodes.length),
    preferences: z.array(onboardingPreferenceSchema).max(64),
    confirm_dating: z.literal(true).optional(),
  })
  .strict();
export type OnboardingConfirm = z.infer<typeof onboardingConfirmSchema>;
export const onboardingReplaceSchema = z
  .object({
    purpose: onboardingPurposeSchema,
    modes: z.array(onboardingModeSchema).min(1).max(onboardingModeCodes.length),
    mode: onboardingModeSchema,
    modes_version: z.number().int().positive(),
    expected_version: version,
    preferences: z.array(onboardingPreferenceSchema).max(64),
    confirm_dating: z.literal(true).optional(),
  })
  .strict();
export type OnboardingReplace = z.infer<typeof onboardingReplaceSchema>;
export const onboardingCorrectionSchema = z
  .object({
    purpose: onboardingPurposeSchema,
    session_id: uuid,
    proposal_id: uuid,
    expected_version: version,
    expected_proposal_version: z.number().int().positive(),
    field: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    correction: z.string().trim().min(1).max(500),
  })
  .strict();
export type OnboardingCorrection = z.infer<typeof onboardingCorrectionSchema>;

export const onboardingCorrectionResponseSchema = z
  .object({
    corrected: z.literal(true),
    proposal_id: uuid,
    proposal_version: z.number().int().positive(),
  })
  .strict();
export const providerConsentSchema = z
  .object({
    purpose: onboardingPurposeSchema,
    provider: z.string().trim().min(1).max(64),
    receipt_version: z.number().int().positive(),
    retention: consentRetentionSchema,
    granted: z.boolean(),
  })
  .strict();
export type ProviderConsent = z.infer<typeof providerConsentSchema>;
export const onboardingConsentResponseSchema = z
  .object({
    consent_id: uuid,
    purpose: onboardingPurposeSchema,
    provider: z.string(),
    receipt_version: z.number().int().positive(),
    retention: consentRetentionSchema,
    granted: z.boolean(),
    withdrawn_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const onboardingSessionResponseSchema = z
  .object({
    session_id: uuid,
    purpose: onboardingPurposeSchema,
    modes: z.array(onboardingModeSchema),
    modes_version: z.number().int().positive(),
    dating_enabled: z.boolean(),
    state: onboardingSessionStateSchema,
    version,
    answer_revision: version,
  })
  .strict();
export const onboardingProposalResponseSchema = z
  .object({
    proposal_id: uuid,
    session_id: uuid,
    purpose: onboardingPurposeSchema,
    mode: onboardingModeSchema,
    answer_revision: version,
    modes_version: z.number().int().positive(),
    proposal_version: z.number().int().positive(),
    state: proposalStateSchema,
    expires_at: z.string().datetime({ offset: true }),
    confidence: z.number().min(0).max(1),
    provenance: z.enum([
      'member_text_extraction',
      'local_rules',
      'provider_model',
      'member_correction',
    ]),
    preferences: z.array(onboardingPreferenceSchema),
    ai_draft: z.literal(true),
  })
  .strict();
export const onboardingPreferencesResponseSchema = z
  .object({
    account_id: uuid,
    purpose: onboardingPurposeSchema,
    version,
    modes: z.array(onboardingModeSchema),
    modes_version: z.number().int().positive(),
    preferences: z.array(onboardingPreferenceSchema),
    confirmed_at: z.string().datetime({ offset: true }),
  })
  .strict();
export const onboardingStateResponseSchema = z
  .object({
    session: onboardingSessionResponseSchema,
    preferences: onboardingPreferencesResponseSchema.nullable(),
    proposal: onboardingProposalResponseSchema.nullable(),
    consent: onboardingConsentResponseSchema.nullable(),
  })
  .strict();
