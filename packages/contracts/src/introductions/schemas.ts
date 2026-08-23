import { z } from 'zod';
import { idSchema } from '../ids.js';
import {
  introductionDecisionSchema,
  introductionModeSchema,
  introductionOutcomeSchema,
  introductionReasonCodeSchema,
} from './enums.js';

const signedCursor = z.string().regex(/^[A-Za-z0-9_-]{32,512}\.[A-Za-z0-9_-]{16,128}$/);
const mode = introductionModeSchema;
export const introductionListQuerySchema = z
  .object({
    mode,
    cursor: signedCursor.optional(),
    limit: z.coerce.number().int().min(1).max(10).default(10),
  })
  .strict();
export type IntroductionListQuery = z.infer<typeof introductionListQuerySchema>;
export const introductionDecisionRequestSchema = z
  .object({ decision: introductionDecisionSchema, batch_id: idSchema })
  .strict();
export type IntroductionDecisionRequest = z.infer<typeof introductionDecisionRequestSchema>;
export const introductionCandidateSchema = z
  .object({
    id: idSchema,
    mode,
    subject: z.object({ display_name: z.string().trim().min(1).max(80) }).strict(),
    reasons: z.array(introductionReasonCodeSchema).min(1).max(8),
    explanation: z.string().min(1).max(500),
    decision: introductionDecisionSchema.nullable(),
    outcome: introductionOutcomeSchema.nullable(),
  })
  .strict();
export type IntroductionCandidate = z.infer<typeof introductionCandidateSchema>;
export const introductionListResponseSchema = z
  .object({
    batch_id: idSchema,
    mode,
    candidates: z.array(introductionCandidateSchema).max(10),
    next_cursor: signedCursor.nullable(),
    refresh_after: z.string().datetime({ offset: true }),
  })
  .strict();
export type IntroductionListResponse = z.infer<typeof introductionListResponseSchema>;
export const introductionDecisionResponseSchema = z
  .object({
    introduction_id: idSchema,
    batch_id: idSchema,
    decision: introductionDecisionSchema,
    outcome: introductionOutcomeSchema.nullable(),
  })
  .strict();
export type IntroductionDecisionResponse = z.infer<typeof introductionDecisionResponseSchema>;
export const introductionHistoryQuerySchema = z
  .object({
    cursor: signedCursor.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const introductionHistoryResponseSchema = z
  .object({ items: z.array(introductionCandidateSchema), next_cursor: signedCursor.nullable() })
  .strict();
export type IntroductionHistoryResponse = z.infer<typeof introductionHistoryResponseSchema>;
export const introductionExplanationResponseSchema = z
  .object({
    introduction_id: idSchema,
    mode,
    reasons: z.array(introductionReasonCodeSchema).min(1).max(8),
    explanation: z.string().min(1).max(500),
  })
  .strict();
