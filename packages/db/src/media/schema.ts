import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const media = pgSchema('media');

export const mediaAssets = media.table('assets', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  purpose: text('purpose').notNull(),
  state: text('state').notNull(),
  declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
  declaredContentType: text('declared_content_type'),
  detectedType: text('detected_type'),
  sha256: text('sha256'),
  version: integer('version').notNull(),
  retentionState: text('retention_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  legalHoldAt: timestamp('legal_hold_at', { withTimezone: true }),
});

export const mediaUploadIntents = media.table(
  'upload_intents',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    quarantineKeyDigest: text('quarantine_key_digest').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    completeIdempotencyDigest: text('complete_idempotency_digest'),
    completePayloadDigest: text('complete_payload_digest'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('media_upload_intents_idempotency_idx').on(table.idempotencyDigest),
    uniqueIndex('media_upload_intents_asset_idx').on(table.assetId),
  ],
);

export const mediaProcessingJobs = media.table('processing_jobs', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  stage: text('stage').notNull(),
  attempt: integer('attempt').notNull(),
  status: text('status').notNull(),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  workerId: text('worker_id'),
  safeError: text('safe_error'),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const mediaRenditions = media.table('renditions', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  variant: text('variant').notNull(),
  cleanKeyDigest: text('clean_key_digest').notNull(),
  contentType: text('content_type').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  sanitizerVersion: text('sanitizer_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const mediaAccessAudit = media.table('access_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  assetId: uuid('asset_id'),
  viewerId: uuid('viewer_id'),
  purpose: text('purpose').notNull(),
  outcome: text('outcome').notNull(),
  reasonCode: text('reason_code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// Keep SQL type checking alive for the schema mirror's migration-only checks.
export const mediaSchemaChecks = sql`media`;
