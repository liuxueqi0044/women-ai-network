import { z } from 'zod';
import { idSchema } from '../ids.js';

export const circleLifecycleSchema = z.enum(['draft', 'active', 'archived']);
export const circleVisibilitySchema = z.enum(['invitation_only', 'approval_required']);
export const circleRoleSchema = z.enum(['owner', 'moderator', 'member']);
export const circleModeSchema = z.enum(['friends', 'activities', 'professional', 'dating']);
/** Version 1 is deliberately closed.  Additive topic changes require a new
 * catalog version plus a migration/contract review; arbitrary labels are not
 * a privacy-safe taxonomy. */
export const circleTopicSchema = z.enum([
  'culture',
  'language_exchange',
  'career',
  'study',
  'parenting',
  'wellbeing',
  'creative_practice',
  'local_life',
  'travel',
  'relationships',
  'mutual_aid',
  'books',
]);
export const circleTopicCatalogVersionSchema = z.literal(1);
export const circleScopeKindSchema = z.enum(['online', 'country', 'city']);
export const circleCountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
export const circleCityLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} .,'’-]+$/u);
export type CircleRole = z.infer<typeof circleRoleSchema>;

const safeText = (max: number) => z.string().trim().min(1).max(max);
const iso = z.string().datetime({ offset: true });
const circleCreateBaseSchema = z
  .object({
    name: safeText(80),
    description: z.string().trim().max(2000).optional(),
    lifecycle: circleLifecycleSchema.default('draft'),
    visibility: circleVisibilitySchema,
    mode: circleModeSchema,
    scope_kind: circleScopeKindSchema,
    country_code: circleCountryCodeSchema.optional(),
    city_label: circleCityLabelSchema.optional(),
    topic_catalog_version: circleTopicCatalogVersionSchema.default(1),
    topics: z.array(circleTopicSchema).min(1).max(12),
    member_cap: z.number().int().min(2).max(500),
  })
  .strict();
export const circleCreateRequestSchema = circleCreateBaseSchema.superRefine((value, ctx) => {
  if (value.lifecycle === 'archived')
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'circles cannot be created archived',
      path: ['lifecycle'],
    });
  if (new Set(value.topics).size !== value.topics.length)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'topics must be unique',
      path: ['topics'],
    });
  if (
    value.scope_kind === 'online' &&
    (value.country_code !== undefined || value.city_label !== undefined)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'online scope cannot include a location',
      path: ['scope_kind'],
    });
  if (
    value.scope_kind === 'country' &&
    (value.country_code === undefined || value.city_label !== undefined)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'country scope requires country_code only',
      path: ['country_code'],
    });
  if (
    value.scope_kind === 'city' &&
    (value.country_code === undefined || value.city_label === undefined)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'city scope requires country_code and city_label',
      path: ['city_label'],
    });
});
export type CircleCreateRequest = z.infer<typeof circleCreateRequestSchema>;
/** Nullable fields are explicit deletion requests. The repository validates
 * their fully merged representation before SQL, so null never means silently
 * retain the old value. */
export const circlePatchRequestSchema = circleCreateBaseSchema
  .partial()
  .extend({
    description: z.string().trim().max(2000).nullable().optional(),
    country_code: circleCountryCodeSchema.nullable().optional(),
    city_label: circleCityLabelSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'circle mode is immutable',
        path: ['mode'],
      });
  });
export type CirclePatchRequest = z.infer<typeof circlePatchRequestSchema>;
export const circleMetadataSchema = z
  .object({
    id: idSchema,
    name: safeText(80),
    description_available: z.boolean(),
    lifecycle: circleLifecycleSchema,
    visibility: circleVisibilitySchema,
    mode: circleModeSchema,
    scope_kind: circleScopeKindSchema,
    country_code: circleCountryCodeSchema.nullable(),
    city_label: circleCityLabelSchema.nullable(),
    topic_catalog_version: circleTopicCatalogVersionSchema,
    topics: z.array(circleTopicSchema).min(1).max(12),
    member_cap: z.number().int().min(2).max(500),
    member_count: z.number().int().nonnegative(),
    role: circleRoleSchema.nullable(),
    created_at: iso,
    updated_at: iso,
  })
  .strict();
export type CircleMetadata = z.infer<typeof circleMetadataSchema>;
export const circleDetailSchema = circleMetadataSchema
  .extend({
    description: z.string().trim().max(2000).nullable(),
  })
  .strict();
export type CircleDetail = z.infer<typeof circleDetailSchema>;
export const circleListSchema = z
  .object({
    items: z.array(circleMetadataSchema).max(50),
    next_cursor: z.string().max(2048).nullable(),
  })
  .strict();
export type CircleList = z.infer<typeof circleListSchema>;
export const circleListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
    mode: circleModeSchema.optional(),
  })
  .strict();
export const circleInviteRequestSchema = z
  .object({ account_id: idSchema, role: z.enum(['member', 'moderator']) })
  .strict();
/**
 * The inviter receives only the opaque invitation resource identifier.  This
 * lets a real HTTP client drive the subsequent accept/decline state machine
 * without exposing invitee metadata or falling back to a database fixture.
 */
export const circleInvitationResponseSchema = z.object({ invitation_id: idSchema }).strict();
export const circleJoinRequestSchema = z
  .object({ message: z.string().trim().max(500).optional() })
  .strict();
export const circleRoleRequestSchema = z.object({ role: circleRoleSchema }).strict();
export const circleNoteRequestSchema = z.object({ body: safeText(10000) }).strict();
export const circleNoteSchema = z
  .object({
    id: idSchema,
    circle_id: idSchema,
    author_account_id: idSchema,
    body: safeText(10000),
    created_at: iso,
  })
  .strict();
export const circleNotesSchema = z
  .object({
    items: z.array(circleNoteSchema).max(50),
    next_cursor: z.string().max(2048).nullable(),
  })
  .strict();
export const circleNotesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const circleMemberSchema = z
  .object({ account_id: idSchema, role: circleRoleSchema, created_at: iso })
  .strict();
export const circleMembersSchema = z
  .object({
    items: z.array(circleMemberSchema).max(50),
    next_cursor: z.string().max(2048).nullable(),
  })
  .strict();
export const circleJoinRequestItemSchema = z
  .object({
    id: idSchema,
    account_id: idSchema,
    message: z.string().trim().max(500).nullable(),
    created_at: iso,
  })
  .strict();
export const circleJoinRequestsSchema = z
  .object({
    items: z.array(circleJoinRequestItemSchema).max(50),
    next_cursor: z.string().max(2048).nullable(),
  })
  .strict();

export class CircleDomainError extends Error {
  constructor(public readonly kind: 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'KEY_UNAVAILABLE') {
    super(`CIRCLE_${kind}`);
  }
}
export interface CircleGrowthGatePort {
  check(input: {
    actorAccountId: string;
    circleId: string;
    subjectAccountId?: string;
    operation: 'read' | 'mutate' | 'admit' | 'escape' | 'archive';
    requiredRole?: CircleRole;
    /** Optional transaction query authority. Repository write barriers pass the
     * same PostgreSQL transaction so a revocation cannot race a committed
     * mutation. Implementations must fail closed if it cannot be used. */
    transaction?: { query(text: string, values?: readonly unknown[]): Promise<unknown> };
  }): Promise<{ allowed: boolean; role?: CircleRole; reason?: string }>;
}
export interface CircleNotificationPort {
  invitation(input: {
    recipientAccountId: string;
    invitationId: string;
    role: 'member' | 'moderator';
    idempotencyKey: string;
  }): Promise<void>;
}
export interface CircleRepositoryPort {
  create(
    actorAccountId: string,
    input: CircleCreateRequest,
    digest: string,
    key: string,
  ): Promise<CircleMetadata>;
  list(
    actorAccountId: string,
    input: { limit: number; cursor?: string; mode?: z.infer<typeof circleModeSchema> },
  ): Promise<CircleList>;
  get(actorAccountId: string, circleId: string): Promise<CircleDetail>;
  patch(
    actorAccountId: string,
    circleId: string,
    input: CirclePatchRequest,
    digest: string,
    key: string,
  ): Promise<CircleMetadata>;
  invite(
    actorAccountId: string,
    circleId: string,
    input: z.infer<typeof circleInviteRequestSchema>,
    digest: string,
    key: string,
  ): Promise<{ invitationId: string }>;
  join(
    actorAccountId: string,
    circleId: string,
    input: z.infer<typeof circleJoinRequestSchema>,
    digest: string,
    key: string,
  ): Promise<void>;
  leave(actorAccountId: string, circleId: string, digest: string, key: string): Promise<void>;
  withdrawJoin(
    actorAccountId: string,
    circleId: string,
    digest: string,
    key: string,
  ): Promise<void>;
  memberAction(
    actorAccountId: string,
    circleId: string,
    memberId: string,
    action: 'approve' | 'decline' | 'remove' | 'role',
    role: CircleRole | undefined,
    digest: string,
    key: string,
  ): Promise<void>;
  respondInvitation(
    actorAccountId: string,
    circleId: string,
    invitationId: string,
    action: 'accept' | 'decline',
    digest: string,
    key: string,
  ): Promise<void>;
  cancelInvitation(
    actorAccountId: string,
    circleId: string,
    invitationId: string,
    digest: string,
    key: string,
  ): Promise<void>;
  addNote(
    actorAccountId: string,
    circleId: string,
    body: string,
    digest: string,
    key: string,
  ): Promise<z.infer<typeof circleNoteSchema>>;
  listNotes(
    actorAccountId: string,
    circleId: string,
    input: { limit: number; cursor?: string },
  ): Promise<z.infer<typeof circleNotesSchema>>;
  listMembers(
    actorAccountId: string,
    circleId: string,
    input: { limit: number; cursor?: string },
  ): Promise<z.infer<typeof circleMembersSchema>>;
  listJoinRequests(
    actorAccountId: string,
    circleId: string,
    input: { limit: number; cursor?: string },
  ): Promise<z.infer<typeof circleJoinRequestsSchema>>;
  reportableEvidence(
    actorAccountId: string,
    targetType: 'circle' | 'note',
    targetId: string,
    circleId?: string,
  ): Promise<
    | {
        subjectAccountId: string;
        sourceVersion: string;
        lifecycle: 'draft' | 'active' | 'archived';
      }
    | { subjectAccountId: string; sourceVersion: string; moderationState: 'visible' }
    | null
  >;
}
