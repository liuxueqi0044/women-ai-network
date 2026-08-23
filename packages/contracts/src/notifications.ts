import { z } from 'zod';
import { idSchema } from './ids.js';
import type { GlobalizationMessageKey } from './globalization/index.js';

export const notificationEventKeySchema = z.enum([
  'letter.received',
  'message.received',
  'connection.created',
  'introduction.available',
  'event.reminder',
  'circle.invitation',
  'safety.action_required',
]);
export type NotificationEventKey = z.infer<typeof notificationEventKeySchema>;
export const notificationCategorySchema = z.enum([
  'letters',
  'messages',
  'connections',
  'introductions',
  'events',
  'circles',
  'critical-safety',
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;
export const notificationChannelSchema = z.enum(['in_app', 'email', 'push']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export const notificationResourceKindSchema = z.enum([
  'letter',
  'conversation',
  'connection',
  'introduction',
  'event',
  'circle',
  'safety_action',
]);
export type NotificationResourceKind = z.infer<typeof notificationResourceKindSchema>;
/** Closed resource-gate registry. An adapter must explicitly implement the
 * kind/version before a list or provider send is allowed. */
export const notificationResourceAdapterRegistry = {
  letter: { version: 1 as const },
  conversation: { version: 1 as const },
  connection: { version: 1 as const },
  introduction: { version: 1 as const },
  event: { version: 1 as const },
  circle: { version: 1 as const },
  safety_action: { version: 1 as const },
} as const satisfies Record<NotificationResourceKind, { version: 1 }>;
export const notificationResourceAdapterRelations = {
  letter: 'letters.letters',
  conversation: 'messaging.conversations',
  connection: 'connection.connections',
  introduction: null,
  event: null,
  circle: 'circles.circles',
  safety_action: 'safety.actions',
} as const satisfies Record<NotificationResourceKind, string | null>;

const safeParam = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const parameterSchemas = {
  'letter.received': z.object({ source: z.enum(['member', 'desk']) }).strict(),
  'message.received': z.object({ conversation_type: z.enum(['direct', 'group']) }).strict(),
  'connection.created': z
    .object({ mode: z.enum(['friends', 'activities', 'professional', 'dating']) })
    .strict(),
  'introduction.available': z.object({ batch: z.enum(['current', 'weekly']) }).strict(),
  'event.reminder': z.object({ hours_before: z.union([z.literal(24), z.literal(1)]) }).strict(),
  'circle.invitation': z.object({ role: z.enum(['member', 'moderator']) }).strict(),
  'safety.action_required': z.object({ action: z.enum(['review', 'appeal', 'security']) }).strict(),
} as const;
export const notificationEventRegistry = {
  'letter.received': {
    version: 1 as const,
    category: 'letters' as const,
    resource_kind: 'letter' as const,
    parameters: parameterSchemas['letter.received'],
    delivery_policy: {
      bypass_channel_preference: false,
      bypass_quiet_hours: false,
      bypass_digest: false,
    },
  },
  'message.received': {
    version: 1 as const,
    category: 'messages' as const,
    resource_kind: 'conversation' as const,
    parameters: parameterSchemas['message.received'],
    delivery_policy: {
      bypass_channel_preference: false,
      bypass_quiet_hours: false,
      bypass_digest: false,
    },
  },
  'connection.created': {
    version: 1 as const,
    category: 'connections' as const,
    resource_kind: 'connection' as const,
    parameters: parameterSchemas['connection.created'],
    delivery_policy: {
      bypass_channel_preference: false,
      bypass_quiet_hours: false,
      bypass_digest: false,
    },
  },
  'introduction.available': {
    version: 1 as const,
    category: 'introductions' as const,
    resource_kind: 'introduction' as const,
    parameters: parameterSchemas['introduction.available'],
    delivery_policy: {
      bypass_channel_preference: false,
      bypass_quiet_hours: false,
      bypass_digest: false,
    },
  },
  'event.reminder': {
    version: 1 as const,
    category: 'events' as const,
    resource_kind: 'event' as const,
    parameters: parameterSchemas['event.reminder'],
    delivery_policy: {
      bypass_channel_preference: false,
      bypass_quiet_hours: false,
      bypass_digest: false,
    },
  },
  'circle.invitation': {
    version: 1 as const,
    category: 'circles' as const,
    resource_kind: 'circle' as const,
    parameters: parameterSchemas['circle.invitation'],
    delivery_policy: {
      bypass_channel_preference: false,
      bypass_quiet_hours: false,
      bypass_digest: false,
    },
  },
  'safety.action_required': {
    version: 1 as const,
    category: 'critical-safety' as const,
    resource_kind: 'safety_action' as const,
    parameters: parameterSchemas['safety.action_required'],
    delivery_policy: {
      bypass_channel_preference: true,
      bypass_quiet_hours: true,
      bypass_digest: true,
    },
  },
} as const;
export const notificationEventSchema = z.discriminatedUnion('event_key', [
  z
    .object({
      event_key: z.literal('letter.received'),
      event_version: z.literal(1),
      parameters: parameterSchemas['letter.received'],
    })
    .strict(),
  z
    .object({
      event_key: z.literal('message.received'),
      event_version: z.literal(1),
      parameters: parameterSchemas['message.received'],
    })
    .strict(),
  z
    .object({
      event_key: z.literal('connection.created'),
      event_version: z.literal(1),
      parameters: parameterSchemas['connection.created'],
    })
    .strict(),
  z
    .object({
      event_key: z.literal('introduction.available'),
      event_version: z.literal(1),
      parameters: parameterSchemas['introduction.available'],
    })
    .strict(),
  z
    .object({
      event_key: z.literal('event.reminder'),
      event_version: z.literal(1),
      parameters: parameterSchemas['event.reminder'],
    })
    .strict(),
  z
    .object({
      event_key: z.literal('circle.invitation'),
      event_version: z.literal(1),
      parameters: parameterSchemas['circle.invitation'],
    })
    .strict(),
  z
    .object({
      event_key: z.literal('safety.action_required'),
      event_version: z.literal(1),
      parameters: parameterSchemas['safety.action_required'],
    })
    .strict(),
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export const notificationIngestRequestSchema = z
  .object({
    recipient_account_id: idSchema,
    resource_kind: notificationResourceKindSchema,
    resource_id: safeParam,
    event: notificationEventSchema,
    idempotency_key: z.string().min(16).max(128),
  })
  .strict();
export type NotificationIngestRequest = z.infer<typeof notificationIngestRequestSchema>;
export const notificationRecordSchema = z
  .object({
    id: idSchema,
    recipient_account_id: idSchema,
    resource_kind: notificationResourceKindSchema,
    resource_id: safeParam,
    event_key: notificationEventKeySchema,
    event_version: z.number().int().positive(),
    category: notificationCategorySchema,
    message_key: z.string().min(1).max(128),
    parameters: z
      .record(z.union([z.string(), z.number()]))
      .refine((v) => Object.keys(v).length <= 4),
    read_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type NotificationRecord = z.infer<typeof notificationRecordSchema>;
export const notificationListSchema = z
  .object({
    items: z.array(notificationRecordSchema),
    next_cursor: z.string().max(2048).nullable(),
  })
  .strict();
export type NotificationList = z.infer<typeof notificationListSchema>;
export const notificationUnreadSchema = z
  .object({ unread_count: z.number().int().nonnegative() })
  .strict();
export type NotificationUnread = z.infer<typeof notificationUnreadSchema>;
export const notificationReadRequestSchema = z
  .object({ idempotency_key: z.string().min(16).max(128) })
  .strict();
export const notificationPreferencesSchema = z
  .object({
    version: z.number().int().nonnegative(),
    items: z
      .array(
        z
          .object({
            channel: notificationChannelSchema,
            category: notificationCategorySchema,
            enabled: z.boolean(),
            quiet_start_minute: z.number().int().min(0).max(1439),
            quiet_end_minute: z.number().int().min(0).max(1439),
            digest_cadence: z.enum(['immediate', 'daily', 'weekly']),
            critical_safety_exception: z.boolean(),
          })
          .strict(),
      )
      .max(21),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
const notificationPreferencesRequestBaseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            channel: notificationChannelSchema,
            category: notificationCategorySchema,
            enabled: z.boolean(),
            quiet_start_minute: z.number().int().min(0).max(1439),
            quiet_end_minute: z.number().int().min(0).max(1439),
            digest_cadence: z.enum(['immediate', 'daily', 'weekly']),
          })
          .strict(),
      )
      .max(21),
  })
  .strict();
const validateExactPreferenceSet = (
  value: z.infer<typeof notificationPreferencesRequestBaseSchema>,
  ctx: z.RefinementCtx,
) => {
  const expected = new Set(
    ['in_app', 'email', 'push'].flatMap((channel) =>
      [
        'letters',
        'messages',
        'connections',
        'introductions',
        'events',
        'circles',
        'critical-safety',
      ].map((category) => `${channel}:${category}`),
    ),
  );
  const actual = value.items.map((item) => `${item.channel}:${item.category}`);
  if (
    actual.length !== expected.size ||
    new Set(actual).size !== actual.length ||
    actual.some((key) => !expected.has(key))
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'preferences must contain exactly one item for every channel/category',
    });
};
export const notificationPreferencesRequestSchema =
  notificationPreferencesRequestBaseSchema.superRefine(validateExactPreferenceSet);
export const notificationPreferencesPutSchema = notificationPreferencesRequestBaseSchema
  .extend({ expected_version: z.number().int().nonnegative() })
  .strict()
  .superRefine(validateExactPreferenceSet);
export type NotificationPreferencesRequest = z.infer<typeof notificationPreferencesRequestSchema>;
export const notificationWakeJobSchema = z.object({ intent_id: idSchema }).strict();
export type NotificationWakeJob = z.infer<typeof notificationWakeJobSchema>;
export interface NotificationResourceGatePort {
  check(input: {
    actorAccountId: string;
    recipientAccountId: string;
    resourceKind: NotificationResourceKind;
    resourceId: string;
    eventKey: NotificationEventKey;
  }): Promise<{ allowed: boolean; retryable?: boolean }>;
}
export interface NotificationProviderPayload {
  intent_id: string;
  idempotency_key: string;
  channel: Exclude<NotificationChannel, 'in_app'>;
  subject: string;
  body: string;
}
export interface NotificationProviderPort {
  readonly channel: Exclude<NotificationChannel, 'in_app'>;
  send(payload: NotificationProviderPayload): Promise<{ accepted: boolean; provider_id?: string }>;
}
export interface NotificationRepositoryPort {
  ingest(input: {
    request: NotificationIngestRequest;
    requestDigest: string;
    now: Date;
  }): Promise<{ record: NotificationRecord; replayed: boolean }>;
  list(
    accountId: string,
    input: { limit: number; cursor?: string; category?: NotificationCategory },
  ): Promise<NotificationList>;
  unreadCount(accountId: string): Promise<NotificationUnread>;
  markRead(accountId: string, id: string, idempotencyKey: string): Promise<boolean>;
  markAllRead(accountId: string, idempotencyKey: string): Promise<number>;
  readPreferences(accountId: string): Promise<NotificationPreferences>;
  replacePreferences(input: {
    accountId: string;
    expectedVersion: number;
    value: NotificationPreferencesRequest;
    requestDigest: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<NotificationPreferences>;
  intentIdsForNotification?(notificationId: string): Promise<string[]>;
}
export const notificationMessageKey: Record<NotificationEventKey, GlobalizationMessageKey> = {
  'letter.received': 'notifications.letter.received',
  'message.received': 'notifications.message.received',
  'connection.created': 'notifications.connection.created',
  'introduction.available': 'notifications.introduction.available',
  'event.reminder': 'notifications.event.reminder',
  'circle.invitation': 'notifications.circle.invitation',
  'safety.action_required': 'notifications.safety.action_required',
};
