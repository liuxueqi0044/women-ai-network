import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts as iamAccounts } from '../schema.js';

/**
 * Typed mirror of the `eligibility` schema. The DDL source of truth is
 * migrations/0003_eligibility.sql and 0004_eligibility_r1_hardening.sql
 * (explicit up/down, checksum-tracked) —
 * this file only mirrors it so repositories get compile-time column types.
 * Drift between here and the SQL is caught by the migration integration
 * tests. CHECK constraints that carry policy (reason-code whitelists,
 * interval invariants) are intentionally NOT mirrored here — they live in
 * the SQL alone and are exercised by the migration tests.
 */

export const eligibility = pgSchema('eligibility');

export const jurisdictionDeclarations = eligibility.table(
  'jurisdiction_declarations',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => iamAccounts.id, { onDelete: 'cascade' }),
    countryCode: text('country_code').notNull(),
    subdivisionCode: text('subdivision_code'),
    source: text('source').notNull(),
    reviewState: text('review_state').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('jurisdiction_declarations_current_unique')
      .on(table.accountId)
      .where(sql`${table.supersededAt} IS NULL`),
    uniqueIndex('jurisdiction_declarations_version_unique').on(table.accountId, table.version),
    index('jurisdiction_declarations_account_created_idx').on(table.accountId, table.createdAt),
  ],
);

export const jurisdictionPolicies = eligibility.table(
  'jurisdiction_policies',
  {
    id: uuid('id').primaryKey(),
    jurisdictionKey: text('jurisdiction_key').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
    ruleHash: text('rule_hash').notNull(),
    locationPrecisionPolicy: text('location_precision_policy').notNull(),
    profilingPolicy: text('profiling_policy').notNull(),
    retentionPolicy: text('retention_policy').notNull(),
    legalBasisRefs: text('legal_basis_refs').array().notNull(),
    reviewedBy: text('reviewed_by').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveUntil: timestamp('effective_until', { withTimezone: true })
      .notNull()
      .default(sql`'infinity'`),
    isSynthetic: boolean('is_synthetic').notNull().default(false),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('jurisdiction_policies_revision_unique').on(table.jurisdictionKey, table.revision),
  ],
);

export const ageEvidence = eligibility.table(
  'age_evidence',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => iamAccounts.id, { onDelete: 'cascade' }),
    birthdayDigest: text('birthday_digest').notNull(),
    birthdayCiphertext: text('birthday_ciphertext').notNull(),
    birthdayNonce: text('birthday_nonce').notNull(),
    birthdayKeyId: text('birthday_key_id').notNull(),
    source: text('source').notNull(),
    verificationCaseId: uuid('verification_case_id'),
    externalAttestationDigest: text('external_attestation_digest'),
    declaredAt: timestamp('declared_at', { withTimezone: true }).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('age_evidence_current_unique')
      .on(table.accountId)
      .where(sql`${table.supersededAt} IS NULL`),
  ],
);

export const ageCredentials = eligibility.table(
  'age_credentials',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => iamAccounts.id, { onDelete: 'cascade' }),
    ageBand: text('age_band').notNull(),
    cohortKey: text('cohort_key').notNull(),
    assuranceLevel: text('assurance_level').notNull(),
    issuerType: text('issuer_type').notNull(),
    sourceEvidenceId: uuid('source_evidence_id')
      .notNull()
      .references(() => ageEvidence.id),
    jurisdictionPolicyId: uuid('jurisdiction_policy_id')
      .notNull()
      .references(() => jurisdictionPolicies.id),
    jurisdictionKey: text('jurisdiction_key'),
    policyRevision: integer('policy_revision').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    derivedAt: timestamp('derived_at', { withTimezone: true }).notNull(),
    derivationVersion: integer('derivation_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('age_credentials_current_unique')
      .on(table.accountId)
      .where(sql`${table.supersededAt} IS NULL`),
    index('age_credentials_account_created_idx').on(table.accountId, table.createdAt),
  ],
);

export const modeDecisions = eligibility.table(
  'mode_decisions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => iamAccounts.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    mode: text('mode').notNull(),
    decision: text('decision').notNull(),
    ageBand: text('age_band').notNull(),
    cohortKey: text('cohort_key').notNull(),
    assuranceLevel: text('assurance_level').notNull(),
    reasonCodes: text('reason_codes').array().notNull(),
    obligations: text('obligations')
      .array()
      .notNull()
      .default(sql`'{}'`),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => jurisdictionPolicies.id),
    policyRevision: integer('policy_revision').notNull(),
    policyHash: text('policy_hash').notNull(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => ageCredentials.id),
    credentialHash: text('credential_hash').notNull(),
    inputHash: text('input_hash').notNull(),
    idempotencyKey: text('idempotency_key'),
    effectiveAtDefaulted: boolean('effective_at_defaulted').notNull().default(false),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    engineVersion: integer('engine_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('mode_decisions_account_evaluated_idx').on(table.accountId, table.evaluatedAt),
    uniqueIndex('mode_decisions_defaulted_idempotency_unique')
      .on(table.accountId, table.idempotencyKey, table.mode)
      .where(sql`${table.idempotencyKey} IS NOT NULL AND ${table.effectiveAtDefaulted}`),
  ],
);

export const partitionDecisions = eligibility.table(
  'partition_decisions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => iamAccounts.id, { onDelete: 'cascade' }),
    subjectAccountId: uuid('subject_account_id')
      .notNull()
      .references(() => iamAccounts.id, { onDelete: 'cascade' }),
    actorAgeBand: text('actor_age_band').notNull(),
    actorCohortKey: text('actor_cohort_key').notNull(),
    subjectAgeBand: text('subject_age_band').notNull(),
    subjectCohortKey: text('subject_cohort_key').notNull(),
    capability: text('capability').notNull(),
    decision: text('decision').notNull(),
    reasonCodes: text('reason_codes').array().notNull(),
    actorPolicyId: uuid('actor_policy_id')
      .notNull()
      .references(() => jurisdictionPolicies.id),
    subjectPolicyId: uuid('subject_policy_id')
      .notNull()
      .references(() => jurisdictionPolicies.id),
    actorPolicyRevision: integer('actor_policy_revision').notNull(),
    subjectPolicyRevision: integer('subject_policy_revision').notNull(),
    actorPolicyHash: text('actor_policy_hash').notNull(),
    subjectPolicyHash: text('subject_policy_hash').notNull(),
    inputHash: text('input_hash').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    engineVersion: integer('engine_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('partition_decisions_actor_evaluated_idx').on(table.actorAccountId, table.evaluatedAt),
  ],
);

export const policyEvents = eligibility.table(
  'policy_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventType: text('event_type').notNull(),
    policyId: uuid('policy_id').references(() => jurisdictionPolicies.id),
    jurisdictionKey: text('jurisdiction_key'),
    accountId: uuid('account_id').references(() => iamAccounts.id, { onDelete: 'set null' }),
    reason: text('reason'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('policy_events_created_idx').on(table.createdAt)],
);
