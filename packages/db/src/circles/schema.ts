import {
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
  bigserial,
} from 'drizzle-orm/pg-core';
import { accounts } from '../schema.js';
export const circle = pgSchema('circles');
export const circles = circle.table(
  'circles',
  {
    id: uuid('id').primaryKey(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    descriptionCiphertext: text('description_ciphertext'),
    descriptionNonce: text('description_nonce'),
    descriptionKeyId: text('description_key_id'),
    lifecycle: text('lifecycle').notNull(),
    visibility: text('visibility').notNull(),
    mode: text('mode').notNull(),
    scopeKind: text('scope_kind').notNull(),
    countryCode: text('country_code'),
    cityLabel: text('city_label'),
    topicCatalogVersion: integer('topic_catalog_version').notNull(),
    topics: jsonb('topics').notNull(),
    memberCap: integer('member_cap').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('circles_owner_idx').on(t.ownerAccountId, t.updatedAt)],
);
export const memberships = circle.table(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    circleId: uuid('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('circles_membership_account_idx').on(t.accountId, t.state)],
);
export const invitations = circle.table('invitations', {
  id: uuid('id').primaryKey(),
  circleId: uuid('circle_id')
    .notNull()
    .references(() => circles.id, { onDelete: 'cascade' }),
  inviterAccountId: uuid('inviter_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  inviteeAccountId: uuid('invitee_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  state: text('state').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const joinRequests = circle.table('join_requests', {
  id: uuid('id').primaryKey(),
  circleId: uuid('circle_id')
    .notNull()
    .references(() => circles.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  messageCiphertext: text('message_ciphertext'),
  messageNonce: text('message_nonce'),
  messageKeyId: text('message_key_id'),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const notes = circle.table(
  'notes',
  {
    id: uuid('id').primaryKey(),
    circleId: uuid('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    authorAccountId: uuid('author_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    bodyCiphertext: text('body_ciphertext').notNull(),
    bodyNonce: text('body_nonce').notNull(),
    bodyKeyId: text('body_key_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('circles_notes_cursor_idx').on(t.circleId, t.createdAt, t.id)],
);
export const idempotency = circle.table(
  'idempotency',
  {
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    resultJson: jsonb('result_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.actorAccountId, t.operation, t.idempotencyDigest] })],
);
export const auditEvents = circle.table('audit_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  circleId: uuid('circle_id').references(() => circles.id, { onDelete: 'cascade' }),
  actorAccountId: uuid('actor_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  subjectAccountId: uuid('subject_account_id').references(() => accounts.id, {
    onDelete: 'set null',
  }),
  metadata: jsonb('metadata').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const notificationHandoff = circle.table('notification_handoff', {
  id: uuid('id').primaryKey(),
  circleId: uuid('circle_id')
    .notNull()
    .references(() => circles.id, { onDelete: 'cascade' }),
  invitationId: uuid('invitation_id')
    .notNull()
    .references(() => invitations.id, { onDelete: 'cascade' }),
  recipientAccountId: uuid('recipient_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  eventKey: text('event_key').notNull(),
  state: text('state').notNull(),
  attempts: integer('attempts').notNull(),
  leaseToken: uuid('lease_token'),
  leaseFence: bigint('lease_fence', { mode: 'number' }).notNull(),
  maxAttempts: integer('max_attempts').notNull(),
  idempotencyDigest: text('idempotency_digest').notNull(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
