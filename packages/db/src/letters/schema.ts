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
import { accounts } from '../schema.js';

export const letters = pgSchema('letters');
export const letterRows = letters.table(
  'letters',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    index('letters_owner_state_idx').on(t.ownerId, t.state, t.updatedAt),
    index('letters_owner_cursor_idx').on(t.ownerId, t.createdAt.desc(), t.id.desc()),
  ],
);
export const letterRevisions = letters.table(
  'letter_revisions',
  {
    id: uuid('id').primaryKey(),
    letterId: uuid('letter_id')
      .notNull()
      .references(() => letterRows.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    sourceHash: text('source_hash').notNull(),
    titleCiphertext: text('title_ciphertext').notNull(),
    titleNonce: text('title_nonce').notNull(),
    bodyCiphertext: text('body_ciphertext').notNull(),
    bodyNonce: text('body_nonce').notNull(),
    metadataCiphertext: text('metadata_ciphertext').notNull(),
    metadataNonce: text('metadata_nonce').notNull(),
    keyId: text('key_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('letters_revisions_letter_revision_unique').on(t.letterId, t.revision),
    index('letters_revisions_source_hash_idx').on(t.letterId, t.sourceHash),
    index('letters_revisions_letter_idx').on(t.letterId, t.revision),
  ],
);
export const publications = letters.table(
  'publications',
  {
    id: uuid('id').primaryKey(),
    letterId: uuid('letter_id')
      .notNull()
      .references(() => letterRows.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => letterRevisions.id),
    sourceHash: text('source_hash').notNull(),
    projectionJson: jsonb('projection_json').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('letters_publications_letter_unique').on(t.letterId),
    uniqueIndex('letters_publications_revision_unique').on(t.revisionId),
  ],
);
export const idempotencyKeys = letters.table(
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
export const auditEvents = letters.table(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id'),
    letterId: uuid('letter_id'),
    eventType: text('event_type').notNull(),
    metadataJson: jsonb('metadata_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('letters_audit_letter_idx').on(t.letterId, t.createdAt)],
);
