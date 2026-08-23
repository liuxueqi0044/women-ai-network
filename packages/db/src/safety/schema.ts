import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const safety = pgSchema('safety');
export const blocks = safety.table(
  'blocks',
  {
    id: uuid('id').primaryKey(),
    blockerAccountId: uuid('blocker_account_id'),
    blockedAccountId: uuid('blocked_account_id'),
    reason: text('reason').notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    requestDigest: text('request_digest').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('safety_blocks_active_unique')
      .on(t.blockerAccountId, t.blockedAccountId)
      .where(sql`state = 'active'`),
    uniqueIndex('safety_blocks_idempotency_unique').on(t.blockerAccountId, t.idempotencyDigest),
    index('safety_blocks_subject_active_idx').on(t.blockedAccountId, t.state),
  ],
);
export const reports = safety.table(
  'reports',
  {
    id: uuid('id').primaryKey(),
    reporterAccountId: uuid('reporter_account_id'),
    subjectAccountId: uuid('subject_account_id'),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    category: text('category').notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    requestDigest: text('request_digest').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('safety_reports_idempotency_unique').on(t.reporterAccountId, t.idempotencyDigest),
  ],
);
export const evidenceSnapshots = safety.table(
  'evidence_snapshots',
  {
    id: uuid('id').primaryKey(),
    reportId: uuid('report_id').notNull(),
    encryptedSnapshot: text('encrypted_snapshot').notNull(),
    snapshotNonce: text('snapshot_nonce').notNull(),
    keyId: text('key_id').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    sourceVersion: text('source_version'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('safety_evidence_report_unique').on(t.reportId)],
);
export const cases = safety.table(
  'cases',
  {
    id: uuid('id').primaryKey(),
    reportId: uuid('report_id').notNull(),
    severity: text('severity').notNull(),
    queue: text('queue').notNull(),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('safety_cases_report_unique').on(t.reportId),
    index('safety_cases_queue_lease_idx').on(t.queue, t.state, t.leaseUntil),
  ],
);
export const caseAccessAudit = safety.table('case_access_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  caseId: uuid('case_id').notNull(),
  actorId: text('actor_id').notNull(),
  purpose: text('purpose').notNull(),
  fieldsClass: text('fields_class').notNull(),
  decision: text('decision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const evidenceHolds = safety.table(
  'evidence_holds',
  {
    id: uuid('id').primaryKey(),
    snapshotId: uuid('snapshot_id').notNull(),
    actorId: text('actor_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('safety_evidence_holds_snapshot_unique').on(t.snapshotId)],
);
export const actions = safety.table(
  'actions',
  {
    id: uuid('id').primaryKey(),
    caseId: uuid('case_id').notNull(),
    actionType: text('action_type').notNull(),
    state: text('state').notNull(),
    proposerId: text('proposer_id').notNull(),
    approverId: text('approver_id'),
    reasonCode: text('reason_code').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveUntil: timestamp('effective_until', { withTimezone: true }),
    executionToken: uuid('execution_token'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('safety_actions_case_idx').on(t.caseId, t.createdAt)],
);
export const appeals = safety.table(
  'appeals',
  {
    id: uuid('id').primaryKey(),
    actionId: uuid('action_id').notNull(),
    appellantAccountId: uuid('appellant_account_id').notNull(),
    category: text('category').notNull(),
    statementCiphertext: text('statement_ciphertext').notNull(),
    statementNonce: text('statement_nonce').notNull(),
    statementKeyId: text('statement_key_id').notNull(),
    state: text('state').notNull(),
    reviewerId: text('reviewer_id'),
    reasonCode: text('reason_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('safety_appeals_open_unique')
      .on(t.actionId)
      .where(sql`state IN ('submitted', 'under_review')`),
  ],
);
export const auditEvents = safety.table(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: text('actor_id'),
    eventType: text('event_type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    metadataJson: text('metadata_json').notNull(),
    previousHash: text('previous_hash'),
    eventHash: text('event_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('safety_audit_events_entity_idx').on(t.entityType, t.entityId, t.createdAt)],
);
