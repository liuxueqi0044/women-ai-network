import { z } from 'zod';
import {
  ageAssuranceStateSchema as ageState,
  communityAccessDecisionSchema,
  identityStateSchema,
  membershipStateSchema,
  providerDecisionSchema,
  providerEventTypeSchema,
  verificationReasonCodeSchema,
} from './enums.js';

const iso = z.string().datetime({ offset: true });
export const createIdentitySessionSchema = z
  .object({
    idempotency_key: z.string().min(16).max(128),
  })
  .strict();
export const identitySessionResponseSchema = z
  .object({
    /** Internal attempt id. The provider session reference is never public. */
    session_id: z.string().uuid(),
    client_token: z.string().min(1).max(2000).optional(),
    expires_at: iso,
  })
  .strict();
export type IdentitySessionResponse = z.infer<typeof identitySessionResponseSchema>;
export const membershipApplicationSchema = z
  .object({
    policy_id: z.string().uuid(),
    policy_revision: z.number().int().positive(),
    consent: z.literal(true),
    statement_category: z.enum(['community_participation', 'safety_commitment']),
  })
  .strict();
export const appealSchema = z
  .object({
    category: z.enum(['incorrect_decision', 'new_information', 'accessibility']),
    statement: z.string().min(1).max(2000),
  })
  .strict();

export const normalizedProviderEventSchema = z
  .object({
    provider_event_id: z.string().min(1).max(200),
    provider_session_reference: z.string().min(1).max(300),
    event_type: providerEventTypeSchema,
    occurred_at: iso,
    decision: providerDecisionSchema,
    identity_confirmed: z.boolean(),
    liveness_result: z.enum(['passed', 'failed', 'not_checked']),
    verified_birth_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    age_thresholds_met: z.array(z.number().int().min(0).max(130)).max(8),
    provider_subject_reference: z.string().min(1).max(300).optional(),
    assurance_expires_at: iso.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.decision === 'verified' &&
      (!event.identity_confirmed || event.liveness_result !== 'passed')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'verified decision requires confirmed identity and passed liveness',
      });
    }
    if (event.verified_birth_date !== undefined && event.decision !== 'verified') {
      context.addIssue({
        code: 'custom',
        path: ['verified_birth_date'],
        message: 'birth date is accepted only with a verified decision',
      });
    }
  });
export type NormalizedProviderEvent = z.infer<typeof normalizedProviderEventSchema>;

export const verificationStatusSchema = z
  .object({
    identity: identityStateSchema,
    age_assurance: ageState,
    membership: membershipStateSchema,
    appeal: z.enum(['none', 'submitted', 'under_review', 'upheld', 'overturned']),
    obligations: z.array(verificationReasonCodeSchema),
  })
  .strict();
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const communityAccessResponseSchema = z
  .object({
    decision: communityAccessDecisionSchema,
    reasons: z.array(verificationReasonCodeSchema),
  })
  .strict();
export type CommunityAccessResponse = z.infer<typeof communityAccessResponseSchema>;
