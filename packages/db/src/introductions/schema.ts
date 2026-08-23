import { integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from '../schema.js';
export const introductions = pgSchema('introductions');
export const batches = introductions.table('batches', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),
  algorithmVersion: text('algorithm_version').notNull(),
  configVersion: text('config_version').notNull(),
  batchLimit: integer('batch_limit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  refreshAfter: timestamp('refresh_after', { withTimezone: true }).notNull(),
});
export const candidates = introductions.table('candidates', {
  id: uuid('id').primaryKey(),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => batches.id, { onDelete: 'cascade' }),
  actorAccountId: uuid('actor_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  subjectAccountId: uuid('subject_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),
  pairKey: text('pair_key').notNull(),
  reasons: text('reasons').array().notNull(),
  visibleFacts: text('visible_facts').array().notNull(),
  score: integer('score').notNull(),
  reasonDigest: text('reason_digest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const decisions = introductions.table('decisions', {
  id: uuid('id').primaryKey(),
  introductionId: uuid('introduction_id')
    .notNull()
    .references(() => candidates.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => batches.id, { onDelete: 'cascade' }),
  actorAccountId: uuid('actor_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  decision: text('decision').notNull(),
  payloadDigest: text('payload_digest').notNull(),
  actorProof: text('actor_proof').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const outcomes = introductions.table('outcomes', {
  id: uuid('id').primaryKey(),
  pairKey: text('pair_key').notNull(),
  mode: text('mode').notNull(),
  introductionId: uuid('introduction_id')
    .notNull()
    .references(() => candidates.id, { onDelete: 'cascade' }),
  subjectIntroductionId: uuid('subject_introduction_id')
    .notNull()
    .references(() => candidates.id, { onDelete: 'cascade' }),
  actorAccountId: uuid('actor_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  subjectAccountId: uuid('subject_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  actorProof: text('actor_proof').notNull(),
  subjectProof: text('subject_proof').notNull(),
  materializationKey: text('materialization_key').notNull(),
  materializedReference: text('materialized_reference').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const cooldowns = introductions.table('cooldowns', {
  pairKey: text('pair_key').notNull(),
  actorAccountId: uuid('actor_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  subjectAccountId: uuid('subject_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),
  untilAt: timestamp('until_at', { withTimezone: true }).notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const idempotencyKeys = introductions.table('idempotency_keys', {
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  keyDigest: text('key_digest').notNull(),
  payloadDigest: text('payload_digest').notNull(),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
