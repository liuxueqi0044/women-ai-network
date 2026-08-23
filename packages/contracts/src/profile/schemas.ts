import { z } from 'zod';
import {
  agePartitionSchema,
  audienceSchema,
  factSensitivitySchema,
  factStateSchema,
  matchingModeSchema,
  profileReasonCodeSchema,
  profileStateSchema,
} from './enums.js';

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const factKey = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const safeText = z.string().trim().min(1).max(500);

export const profileWriteSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80),
    city: z.string().trim().min(1).max(80).optional(),
    country_code: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict();

export const factWriteSchema = z
  .object({
    value: z.union([safeText, z.boolean(), z.number().finite(), uuid]),
    source: z.literal('user_confirmed'),
  })
  .strict();

export const factUsageSchema = z
  .object({
    mode: matchingModeSchema,
    matching_enabled: z.boolean(),
  })
  .strict();

export const factAudienceSchema = z
  .object({
    audience: audienceSchema,
    age_partition: agePartitionSchema,
    mode: matchingModeSchema,
  })
  .strict();

export const profileMutationHeadersSchema = z
  .object({
    idempotency_key: z.string().min(16).max(128),
    expected_version: z.number().int().nonnegative(),
  })
  .strict();

export const profileFactViewSchema = z
  .object({
    fact_key: factKey,
    value: z.union([safeText, z.boolean(), z.number().finite(), uuid]),
    sensitivity: factSensitivitySchema,
    state: factStateSchema,
    source: z.enum(['user_confirmed', 'approved_draft']),
    confirmed_at: iso,
  })
  .strict();

const profileViewFields = {
  profile_id: uuid,
  display_name: safeText,
  city: z.string().max(80).optional(),
  country_code: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  state: profileStateSchema,
  version: z.number().int().nonnegative(),
  facts: z.array(profileFactViewSchema),
} as const;
export const profileMemberViewSchema = z.object(profileViewFields).strict();
export const profileSelfViewSchema = z.object({ ...profileViewFields, account_id: uuid }).strict();
export const profileViewSchema = z.union([profileSelfViewSchema, profileMemberViewSchema]);

export const profilePreviewQuerySchema = z
  .object({
    view: z.enum(['member', 'matching', 'self']),
    mode: matchingModeSchema.default('friends'),
  })
  .strict();

export const profilePublishResponseSchema = z
  .object({
    profile_id: uuid,
    snapshot_id: uuid,
    version: z.number().int().nonnegative(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    published_at: iso,
  })
  .strict();
export const profileMutationResponseSchema = z
  .object({
    profile_id: uuid,
    version: z.number().int().nonnegative(),
    state: profileStateSchema,
  })
  .strict();

export const profileErrorReasonSchema = profileReasonCodeSchema;
export type ProfileWrite = z.infer<typeof profileWriteSchema>;
export type FactWrite = z.infer<typeof factWriteSchema>;
export type ProfileMutationResponse = z.infer<typeof profileMutationResponseSchema>;
export type FactUsage = z.infer<typeof factUsageSchema>;
export type FactAudience = z.infer<typeof factAudienceSchema>;
export type ProfileView = z.infer<typeof profileViewSchema>;
export type ProfileSelfView = z.infer<typeof profileSelfViewSchema>;
export type ProfileMemberView = z.infer<typeof profileMemberViewSchema>;
export type ProfilePublishResponse = z.infer<typeof profilePublishResponseSchema>;
