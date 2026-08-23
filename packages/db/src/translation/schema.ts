import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';
import { accounts } from '../schema.js';
import { letterRevisions, letterRows } from '../letters/schema.js';

export const translation = pgSchema('translation');
export const tasks = translation.table(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    letterId: uuid('letter_id')
      .notNull()
      .references(() => letterRows.id, { onDelete: 'cascade' }),
    sourceRevisionId: uuid('source_revision_id')
      .notNull()
      .references(() => letterRevisions.id, { onDelete: 'cascade' }),
    sourceRevision: integer('source_revision').notNull(),
    sourceHash: text('source_hash').notNull(),
    sourceLocale: text('source_locale').notNull(),
    targetLocale: text('target_locale').notNull(),
    providerId: text('provider_id').notNull(),
    providerVersion: text('provider_version').notNull(),
    consentId: uuid('consent_id'),
    consentProviderVersion: text('consent_provider_version'),
    consentProcessingRegion: text('consent_processing_region'),
    consentRetentionPolicy: text('consent_retention_policy'),
    consentRetentionSeconds: integer('consent_retention_seconds'),
    state: text('state').notNull(),
    requestDigest: text('request_digest').notNull(),
    keyDigest: text('key_digest').notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('translation_tasks_claim_idx').on(t.state, t.nextRetryAt, t.leaseUntil, t.createdAt),
    index('translation_tasks_letter_idx').on(t.letterId, t.sourceRevisionId, t.targetLocale),
    uniqueIndex('translation_tasks_key_unique').on(
      t.sourceKind,
      t.letterId,
      t.sourceRevisionId,
      t.sourceRevision,
      t.sourceHash,
      t.sourceLocale,
      t.targetLocale,
      t.providerId,
      t.providerVersion,
      t.consentId,
    ),
    uniqueIndex('translation_tasks_owner_key_unique').on(t.ownerId, t.keyDigest),
  ],
);
export const retryWakeups = translation.table(
  'retry_wakeups',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }).notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('translation_retry_wakeups_due_idx').on(t.nextRetryAt, t.enqueuedAt, t.taskId)],
);
export const results = translation.table('results', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  titleCiphertext: text('title_ciphertext').notNull(),
  titleNonce: text('title_nonce').notNull(),
  bodyCiphertext: text('body_ciphertext').notNull(),
  bodyNonce: text('body_nonce').notNull(),
  keyId: text('key_id').notNull(),
  resultHash: text('result_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const consents = translation.table(
  'consents',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    letterId: uuid('letter_id')
      .notNull()
      .references(() => letterRows.id, { onDelete: 'cascade' }),
    sourceRevisionId: uuid('source_revision_id')
      .notNull()
      .references(() => letterRevisions.id, { onDelete: 'cascade' }),
    sourceHash: text('source_hash').notNull(),
    providerId: text('provider_id').notNull(),
    processingRegion: text('processing_region').notNull(),
    retentionPolicy: text('retention_policy').notNull(),
    providerVersion: text('provider_version').notNull(),
    retentionSeconds: integer('retention_seconds').notNull(),
    capability: text('capability').notNull(),
    noTraining: boolean('no_training').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('translation_consents_lookup_idx').on(
      t.ownerId,
      t.letterId,
      t.sourceRevisionId,
      t.providerId,
      t.expiresAt,
      t.revokedAt,
    ),
    index('translation_consents_binding_idx').on(
      t.ownerId,
      t.letterId,
      t.sourceRevisionId,
      t.sourceHash,
      t.providerId,
      t.providerVersion,
      t.processingRegion,
      t.retentionPolicy,
      t.retentionSeconds,
      t.expiresAt,
      t.revokedAt,
    ),
  ],
);
export const idempotencyKeys = translation.table(
  'idempotency_keys',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    keyDigest: text('key_digest').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    resultJson: jsonb('result_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.keyDigest] })],
);
