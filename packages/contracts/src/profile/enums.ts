import { z } from 'zod';

export const profileStateSchema = z.enum(['draft', 'active', 'paused', 'deleted']);
export type ProfileState = z.infer<typeof profileStateSchema>;
export const factStateSchema = z.enum(['proposed', 'confirmed', 'withdrawn']);
export type FactState = z.infer<typeof factStateSchema>;
export const factSensitivitySchema = z.enum(['low', 'sensitive', 'ai_only']);
export type FactSensitivity = z.infer<typeof factSensitivitySchema>;
export const factValueKindSchema = z.enum(['text', 'boolean', 'enum', 'media_ref', 'number']);
export type FactValueKind = z.infer<typeof factValueKindSchema>;
export const matchingModeSchema = z.enum([
  'friends',
  'activities',
  'professional',
  'circles',
  'events',
  'dating',
]);
export type MatchingMode = z.infer<typeof matchingModeSchema>;
export const audienceSchema = z.enum(['self', 'verified_members', 'connections', 'nobody']);
export type Audience = z.infer<typeof audienceSchema>;
export const relationshipSchema = z.enum(['self', 'none', 'connection', 'member']);
export type Relationship = z.infer<typeof relationshipSchema>;
export const agePartitionSchema = z.enum(['unknown', 'youth', 'adult']);
export type AgePartition = z.infer<typeof agePartitionSchema>;
export const profileReasonCodeSchema = z.enum([
  'PROFILE_NOT_FOUND',
  'PROFILE_NOT_ACTIVE',
  'COMMUNITY_ACCESS_REQUIRED',
  'AGE_PARTITION_DENIED',
  'FACT_NOT_VISIBLE',
  'AI_ONLY_FACT',
  'OPTIMISTIC_CONCURRENCY_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_FACT',
  'MEDIA_REFERENCE_INVALID',
]);
export type ProfileReasonCode = z.infer<typeof profileReasonCodeSchema>;

export function transitionProfile(from: ProfileState, to: ProfileState): boolean {
  if (from === to) return true;
  const allowed: Record<ProfileState, readonly ProfileState[]> = {
    draft: ['active', 'deleted'],
    active: ['paused', 'deleted'],
    paused: ['active', 'deleted'],
    deleted: [],
  };
  return allowed[from].includes(to);
}
