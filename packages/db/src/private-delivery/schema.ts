import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigserial,
} from 'drizzle-orm/pg-core';

export const privateDelivery = pgSchema('private_delivery');

export const deliveries = privateDelivery.table(
  'deliveries',
  {
    id: uuid('id').primaryKey(),
    senderId: uuid('sender_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    connectionEpoch: integer('connection_epoch').notNull(),
    letterId: uuid('letter_id'),
    revisionId: uuid('revision_id'),
    revision: integer('revision').notNull(),
    sourceHash: text('source_hash').notNull(),
    purpose: text('purpose').notNull(),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    snapshotTitleCiphertext: text('snapshot_title_ciphertext').notNull(),
    snapshotTitleNonce: text('snapshot_title_nonce').notNull(),
    snapshotBodyCiphertext: text('snapshot_body_ciphertext').notNull(),
    snapshotBodyNonce: text('snapshot_body_nonce').notNull(),
    snapshotMetadataCiphertext: text('snapshot_metadata_ciphertext').notNull(),
    snapshotMetadataNonce: text('snapshot_metadata_nonce').notNull(),
    snapshotKeyId: text('snapshot_key_id').notNull(),
    snapshotPolicyJson: jsonb('snapshot_policy_json').notNull(),
    leaseOwner: text('lease_owner'),
    leaseTokenDigest: text('lease_token_digest'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    recipientHiddenAt: timestamp('recipient_hidden_at', { withTimezone: true }),
    senderWithdrawnAt: timestamp('sender_withdrawn_at', { withTimezone: true }),
  },
  (table) => [
    index('private_delivery_recipient_idx').on(table.recipientId, table.createdAt, table.id),
    index('private_delivery_sender_idx').on(table.senderId, table.createdAt, table.id),
    index('private_delivery_claim_idx').on(
      table.state,
      table.leaseUntil,
      table.createdAt,
      table.id,
    ),
    uniqueIndex('private_delivery_business_unique').on(
      table.senderId,
      table.recipientId,
      table.connectionId,
      table.connectionEpoch,
      table.letterId,
      table.revision,
      table.purpose,
    ),
    check('private_delivery_source_hash_chk', sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const idempotencyKeys = privateDelivery.table('idempotency_keys', {
  senderId: uuid('sender_id').notNull(),
  keyDigest: text('key_digest').notNull(),
  payloadDigest: text('payload_digest').notNull(),
  deliveryId: uuid('delivery_id').notNull(),
  resultJson: jsonb('result_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const wakeIntents = privateDelivery.table('wake_intents', {
  deliveryId: uuid('delivery_id').notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(20),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const transitions = privateDelivery.table('transitions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  deliveryId: uuid('delivery_id').notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  actorId: uuid('actor_id'),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const notificationOutbox = privateDelivery.table('notification_outbox', {
  id: uuid('id').primaryKey(),
  deliveryId: uuid('delivery_id').notNull(),
  recipientId: uuid('recipient_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
});

export const evidenceSnapshots = privateDelivery.table('evidence_snapshots', {
  id: uuid('id').primaryKey(),
  deliveryId: uuid('delivery_id').notNull(),
  capturedBy: uuid('captured_by').notNull(),
  category: text('category').notNull(),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  keyId: text('key_id').notNull(),
  sourceHash: text('source_hash').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  legalHold: boolean('legal_hold').notNull().default(true),
});
