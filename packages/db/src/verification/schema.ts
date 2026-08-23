import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
  bigserial,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { accounts } from '../schema.js';

export const verification = pgSchema('verification');
export const identityCases = verification.table(
  'identity_cases',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    state: text('state').notNull(),
    ageAssuranceState: text('age_assurance_state').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastProviderOccurredAt: timestamp('last_provider_occurred_at', { withTimezone: true }),
    lastProviderEventId: text('last_provider_event_id'),
  },
  (t) => [
    uniqueIndex('identity_cases_active_account_unique')
      .on(t.accountId)
      .where(sql`state NOT IN ('failed','expired','canceled')`),
  ],
);
export const verificationAttempts = verification.table('verification_attempts', {
  id: uuid('id').primaryKey(),
  caseId: uuid('case_id').notNull(),
  provider: text('provider').notNull(),
  sessionRefCiphertext: text('session_ref_ciphertext').notNull(),
  sessionRefNonce: text('session_ref_nonce').notNull(),
  sessionRefKeyId: text('session_ref_key_id').notNull(),
  sessionRefDigest: text('session_ref_digest').notNull(),
  state: text('state').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const providerEvents = verification.table(
  'provider_events',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    lastErrorSafe: text('last_error_safe'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    processingToken: uuid('processing_token'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('provider_events_provider_id_unique').on(t.provider, t.providerEventId)],
);
export const identityBindings = verification.table(
  'identity_bindings',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    subjectDigest: text('subject_digest').notNull(),
    accountId: uuid('account_id').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('identity_bindings_subject_unique').on(t.provider, t.subjectDigest)],
);
export const membershipPolicies = verification.table(
  'membership_policies',
  {
    id: uuid('id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    contentHash: text('content_hash').notNull(),
    legalBasisRef: text('legal_basis_ref').notNull(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveUntil: timestamp('effective_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.revision] })],
);
export const membershipCases = verification.table('membership_cases', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  policyId: uuid('policy_id').notNull(),
  policyRevision: integer('policy_revision').notNull(),
  policyContentHash: text('policy_content_hash').notNull(),
  statementCategory: text('statement_category').notNull(),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
  state: text('state').notNull(),
  version: integer('version').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const membershipReviews = verification.table('membership_reviews', {
  id: uuid('id').primaryKey(),
  membershipCaseId: uuid('membership_case_id').notNull(),
  reviewerPrincipal: text('reviewer_principal').notNull(),
  decision: text('decision').notNull(),
  reasonCode: text('reason_code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const membershipAppeals = verification.table('membership_appeals', {
  id: uuid('id').primaryKey(),
  membershipCaseId: uuid('membership_case_id').notNull(),
  category: text('category').notNull(),
  statementCiphertext: text('statement_ciphertext').notNull(),
  statementNonce: text('statement_nonce').notNull(),
  statementKeyId: text('statement_key_id').notNull(),
  state: text('state').notNull(),
  reviewerPrincipal: text('reviewer_principal'),
  reasonCode: text('reason_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});
export const redactionRequests = verification.table('redaction_requests', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  state: text('state').notNull(),
  legalHold: boolean('legal_hold').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
export const auditEvents = verification.table(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id'),
    caseId: uuid('case_id'),
    eventType: text('event_type').notNull(),
    reasonCode: text('reason_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('verification_audit_account_idx').on(t.accountId, t.createdAt)],
);
