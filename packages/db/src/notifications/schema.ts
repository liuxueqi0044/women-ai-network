import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { accounts } from '../schema.js';
export const notifications = pgSchema('notifications');
export const notificationRows = notifications.table('notifications', {
  id: uuid('id').primaryKey(),
  recipientAccountId: uuid('recipient_account_id')
    .notNull()
    .references(() => accounts.id),
  resourceKind: text('resource_kind').notNull(),
  resourceId: text('resource_id').notNull(),
  eventKey: text('event_key').notNull(),
  eventVersion: integer('event_version').notNull(),
  category: text('category').notNull(),
  parameters: jsonb('parameters').notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
  suppressedAt: timestamp('suppressed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const providerIntents = notifications.table(
  'provider_intents',
  {
    id: uuid('id').primaryKey(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notificationRows.id),
    recipientAccountId: uuid('recipient_account_id')
      .notNull()
      .references(() => accounts.id),
    channel: text('channel').notNull(),
    state: text('state').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseFence: integer('lease_fence').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    digestDueAt: timestamp('digest_due_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    providerId: text('provider_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('notifications_provider_intent_unique').on(t.notificationId, t.channel)],
);
export const providerAttempts = notifications.table('provider_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  intentId: uuid('intent_id')
    .notNull()
    .references(() => providerIntents.id),
  attemptNo: integer('attempt_no').notNull(),
  outcome: text('outcome').notNull(),
  errorCode: text('error_code'),
  providerId: text('provider_id'),
  payloadDigest: text('payload_digest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const preferenceRows = notifications.table(
  'preferences',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    channel: text('channel').notNull(),
    category: text('category').notNull(),
    enabled: boolean('enabled').notNull(),
    quietStartMinute: smallint('quiet_start_minute').notNull(),
    quietEndMinute: smallint('quiet_end_minute').notNull(),
    digestCadence: text('digest_cadence').notNull(),
    criticalSafetyException: boolean('critical_safety_exception').notNull(),
    version: integer('version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.channel, t.category] })],
);
