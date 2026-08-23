import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Typed view of the `iam` schema. The DDL source of truth is
 * migrations/*.sql (explicit, up/down, checksum-tracked) — this file only
 * mirrors it so repositories get compile-time column types. Any drift
 * between here and the SQL is caught by the migration integration tests.
 */

export const iam = pgSchema('iam');

export {
  privateDelivery,
  deliveries,
  idempotencyKeys as privateDeliveryIdempotencyKeys,
  transitions as privateDeliveryTransitions,
  notificationOutbox as privateDeliveryNotificationOutbox,
  evidenceSnapshots as privateDeliveryEvidenceSnapshots,
} from './private-delivery/schema.js';
export { worldDiscovery, discoveryIndex, bookmarks } from './world/schema.js';
export {
  globalization,
  accountPreferences,
  preferenceIdempotency,
  preferenceAudit,
} from './globalization/schema.js';

export const accounts = iam.table(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    emailDigest: text('email_digest'),
    emailCiphertext: text('email_ciphertext').notNull(),
    emailNonce: text('email_nonce').notNull(),
    emailKeyId: text('email_key_id').notNull(),
    state: text('state').notNull(),
    stateReason: text('state_reason').notNull(),
    stateActorType: text('state_actor_type').notNull(),
    stateActorId: uuid('state_actor_id'),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // Partial index matching the SQL DDL: NULL after deletion, unique otherwise.
    uniqueIndex('accounts_email_digest_idx')
      .on(table.emailDigest)
      .where(sql`${table.emailDigest} IS NOT NULL`),
  ],
);

export const passwordCredentials = iam.table('password_credentials', {
  accountId: uuid('account_id').primaryKey(),
  hash: text('hash').notNull(),
  hashVersion: integer('hash_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const devices = iam.table(
  'devices',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    deviceDigest: text('device_digest').notNull(),
    label: text('label').notNull(),
    uaDigest: text('ua_digest').notNull(),
    uaSummary: text('ua_summary'),
    ipHmac: text('ip_hmac').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('devices_account_digest_idx').on(table.accountId, table.deviceDigest)],
);

export const sessions = iam.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    parentId: uuid('parent_id'),
    successorId: uuid('successor_id'),
    tokenDigest: text('token_digest').notNull(),
    generation: integer('generation').notNull().default(1),
    state: text('state').notNull(),
    authLevel: text('auth_level').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('sessions_token_digest_idx').on(table.tokenDigest),
    index('sessions_account_state_idx').on(table.accountId, table.state),
    index('sessions_family_idx').on(table.familyId),
  ],
);

export const mfaFactors = iam.table(
  'mfa_factors',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    state: text('state').notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretNonce: text('secret_nonce').notNull(),
    secretKeyId: text('secret_key_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    index('mfa_factors_account_idx').on(table.accountId),
    // R1-04: at most one pending OR enabled factor per account (the unique
    // slot); disabled does not occupy it. Mirrors the 0002 migration DDL.
    uniqueIndex('mfa_factors_active_unique_idx')
      .on(table.accountId)
      .where(sql`state IN ('pending', 'enabled')`),
  ],
);

export const mfaChallenges = iam.table(
  'mfa_challenges',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // R1-06A: the challenge binds to the device used for the password step.
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    methodSet: text('method_set')
      .array()
      .notNull()
      .default(sql`ARRAY['totp', 'recovery']`),
    digest: text('digest').notNull(),
    state: text('state').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('mfa_challenges_digest_idx').on(table.digest),
    index('mfa_challenges_account_state_idx').on(table.accountId, table.state),
    check(
      'mfa_challenges_method_set_chk',
      sql`cardinality(${table.methodSet}) > 0 AND ${table.methodSet} <@ ARRAY['totp', 'recovery']`,
    ),
    check(
      'mfa_challenges_pending_device_chk',
      sql`${table.state} <> 'pending' OR ${table.deviceId} IS NOT NULL`,
    ),
  ],
);

export const recoveryCodes = iam.table(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    factorId: uuid('factor_id')
      .notNull()
      .references(() => mfaFactors.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    codeDigest: text('code_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('recovery_codes_digest_idx').on(table.codeDigest)],
);

export const accountStateTransitions = iam.table(
  'account_state_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    reason: text('reason').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    // R1-06C: which request produced this transition (audit correlation).
    requestId: text('request_id'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('account_state_transitions_account_idx').on(table.accountId),
    index('account_state_transitions_request_idx').on(table.requestId),
  ],
);

export const securityEvents = iam.table(
  'security_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventType: text('event_type').notNull(),
    accountId: uuid('account_id'),
    sessionId: uuid('session_id'),
    deviceId: uuid('device_id'),
    severity: text('severity').notNull(),
    reason: text('reason').notNull(),
    ipHmac: text('ip_hmac'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('security_events_account_idx').on(table.accountId),
    index('security_events_type_idx').on(table.eventType, table.createdAt),
  ],
);

export * from './eligibility/schema.js';
export * from './verification/schema.js';
export * from './profile/schema.js';
export {
  onboarding,
  interviewSessions,
  answerRevisions,
  extractionProposals,
  preferenceSets,
  providerConsents,
  consentReceipts,
  corrections,
  idempotencyKeys as onboardingIdempotencyKeys,
} from './onboarding/schema.js';
export {
  introductions,
  batches as introductionBatches,
  candidates as introductionCandidates,
  decisions as introductionDecisions,
  outcomes as introductionOutcomes,
  cooldowns as introductionCooldowns,
  idempotencyKeys as introductionIdempotencyKeys,
} from './introductions/schema.js';
export {
  notifications,
  notificationRows,
  providerIntents,
  providerAttempts,
  preferenceRows,
} from './notifications/schema.js';
export {
  circle,
  circles,
  memberships as circleMemberships,
  invitations as circleInvitations,
  joinRequests as circleJoinRequests,
  notes as circleNotes,
  idempotency as circleIdempotency,
  auditEvents as circleAuditEvents,
  notificationHandoff as circleNotificationHandoff,
} from './circles/schema.js';
export * from './media/schema.js';
export {
  letters,
  letterRows,
  letterRevisions,
  publications,
  idempotencyKeys as letterIdempotencyKeys,
  auditEvents as letterAuditEvents,
} from './letters/schema.js';
export {
  translation,
  tasks as translationTasks,
  results as translationResults,
  consents as translationConsents,
  idempotencyKeys as translationIdempotencyKeys,
} from './translation/schema.js';
export {
  safety,
  blocks,
  reports,
  evidenceSnapshots,
  evidenceHolds,
  cases,
  caseAccessAudit,
  actions,
  appeals,
  auditEvents as safetyAuditEvents,
} from './safety/schema.js';
