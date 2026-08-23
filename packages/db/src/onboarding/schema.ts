import { boolean, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from '../schema.js';
export const onboarding = pgSchema('onboarding');
export const interviewSessions = onboarding.table('interview_sessions', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  modes: text('modes').array().notNull(),
  modesVersion: integer('modes_version').notNull(),
  datingEnabled: boolean('dating_enabled').notNull(),
  state: text('state').notNull(),
  version: integer('version').notNull(),
  answerRevision: integer('answer_revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const answerRevisions = onboarding.table('answer_revisions', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => interviewSessions.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  mode: text('mode').notNull(),
  revision: integer('revision').notNull(),
  answerCiphertext: text('answer_ciphertext').notNull(),
  answerNonce: text('answer_nonce').notNull(),
  answerKeyId: text('answer_key_id').notNull(),
  answerHash: text('answer_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const extractionProposals = onboarding.table('extraction_proposals', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => interviewSessions.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  mode: text('mode').notNull(),
  answerRevision: integer('answer_revision').notNull(),
  modesVersion: integer('modes_version').notNull(),
  proposalVersion: integer('proposal_version').notNull(),
  state: text('state').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  confidence: text('confidence').notNull(),
  provenance: text('provenance').notNull(),
  payloadCiphertext: text('payload_ciphertext').notNull(),
  payloadNonce: text('payload_nonce').notNull(),
  payloadKeyId: text('payload_key_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});
export const preferenceSets = onboarding.table('preference_sets', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  version: integer('version').notNull(),
  current: boolean('current').notNull(),
  modes: text('modes').array().notNull(),
  modesVersion: integer('modes_version').notNull(),
  normalizedJson: jsonb('normalized_json').notNull(),
  preferencesCiphertext: text('preferences_ciphertext').notNull(),
  preferencesNonce: text('preferences_nonce').notNull(),
  preferencesKeyId: text('preferences_key_id').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
  source: text('source').notNull(),
});
export const providerConsents = onboarding.table('provider_consents', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  provider: text('provider').notNull(),
  receiptVersion: integer('receipt_version').notNull(),
  retention: text('retention').notNull(),
  granted: boolean('granted').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
});
export const consentReceipts = onboarding.table('consent_receipts', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  provider: text('provider').notNull(),
  receiptVersion: integer('receipt_version').notNull(),
  retention: text('retention').notNull(),
  granted: boolean('granted').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
});
export const corrections = onboarding.table('corrections', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  proposalId: uuid('proposal_id')
    .notNull()
    .references(() => extractionProposals.id),
  purpose: text('purpose').notNull(),
  expectedVersion: integer('expected_version').notNull(),
  expectedProposalVersion: integer('expected_proposal_version').notNull(),
  field: text('field').notNull(),
  correctionCiphertext: text('correction_ciphertext').notNull(),
  correctionNonce: text('correction_nonce').notNull(),
  correctionKeyId: text('correction_key_id').notNull(),
  correctionHash: text('correction_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const idempotencyKeys = onboarding.table('idempotency_keys', {
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  keyDigest: text('key_digest').notNull(),
  payloadDigest: text('payload_digest').notNull(),
  resultCiphertext: text('result_ciphertext').notNull(),
  resultNonce: text('result_nonce').notNull(),
  resultKeyId: text('result_key_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
