import { z } from 'zod';

export const introductionModeCodes = [
  'friends',
  'activities',
  'professional',
  'circles',
  'events',
  'dating',
] as const;
export const introductionModeSchema = z.enum(introductionModeCodes);
export type IntroductionMode = z.infer<typeof introductionModeSchema>;

export const introductionReasonCodes = [
  'PREFERENCES_ALIGN',
  'SHARED_INTEREST',
  'COMMUNICATION_FIT',
  'PACE_ALIGNMENT',
  'AVAILABILITY_ALIGNMENT',
  'LANGUAGE_ALIGNMENT',
  'GEOGRAPHY_ALIGNMENT',
  'VALUES_ALIGNMENT',
] as const;
export const introductionReasonCodeSchema = z.enum(introductionReasonCodes);
export type IntroductionReasonCode = z.infer<typeof introductionReasonCodeSchema>;

export const introductionDecisionSchema = z.enum(['interested', 'pass']);
export type IntroductionDecision = z.infer<typeof introductionDecisionSchema>;
export const introductionOutcomeSchema = z.enum(['mutual', 'none']);
export type IntroductionOutcome = z.infer<typeof introductionOutcomeSchema>;
