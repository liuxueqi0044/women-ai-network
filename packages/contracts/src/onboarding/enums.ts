import { z } from 'zod';

export const onboardingModeCodes = [
  'friends',
  'activities',
  'professional',
  'circles',
  'events',
  'dating',
] as const;
export const onboardingModeSchema = z.enum(onboardingModeCodes);
export type OnboardingMode = z.infer<typeof onboardingModeSchema>;
export const onboardingPurposeSchema = z.enum(['discovery', 'profile']);
export type OnboardingPurpose = z.infer<typeof onboardingPurposeSchema>;
export const onboardingStrengthSchema = z.enum([
  'hard_requirement',
  'strong_preference',
  'weak_preference',
  'does_not_matter',
]);
export type OnboardingStrength = z.infer<typeof onboardingStrengthSchema>;
export const onboardingCriterionSchema = z.enum([
  'communication_style',
  'communication_frequency',
  'shared_interests',
  'geography',
  'availability',
  'values',
  'lifestyle',
  'language',
  'distance',
]);
export type OnboardingCriterion = z.infer<typeof onboardingCriterionSchema>;
export const onboardingSessionStateSchema = z.enum(['active', 'completed', 'withdrawn']);
export type OnboardingSessionState = z.infer<typeof onboardingSessionStateSchema>;
export const proposalStateSchema = z.enum([
  'pending',
  'confirmed',
  'expired',
  'rejected',
  'corrected',
]);
export type ProposalState = z.infer<typeof proposalStateSchema>;
export const consentRetentionSchema = z.enum(['none', 'session', 'thirty_days']);
export type ConsentRetention = z.infer<typeof consentRetentionSchema>;

export const forbiddenOnboardingKeys = [
  'date_of_birth',
  'dob',
  'birthday',
  'document',
  'document_image',
  'identity_evidence',
  'identity_number',
  'gender',
  'sex',
  'age',
] as const;
