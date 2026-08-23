import {
  bigserial,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { accounts } from '../schema.js';

export const connection = pgSchema('connection');
export const connections = connection.table(
  'connections',
  {
    id: uuid('id').primaryKey(),
    accountA: uuid('account_a')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    accountB: uuid('account_b')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    requesterAccountId: uuid('requester_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    recipientAccountId: uuid('recipient_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('connection_active_pair_unique')
      .on(t.accountA, t.accountB)
      .where(sql`${t.state} IN ('pending','accepted')`),
    index('connection_actor_state_idx').on(t.accountA, t.state, t.updatedAt),
    index('connection_subject_state_idx').on(t.accountB, t.state, t.updatedAt),
  ],
);
export const idempotencyKeys = connection.table(
  'idempotency_keys',
  {
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    resultJson: jsonb('result_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.actorAccountId, t.operation, t.idempotencyDigest] })],
);
export const transitions = connection.table(
  'transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    actorAccountId: uuid('actor_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('connection_transitions_connection_idx').on(t.connectionId, t.createdAt)],
);
