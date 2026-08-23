import {
  bigserial,
  boolean,
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

export const profile = pgSchema('profile');
export const profiles = profile.table(
  'profiles',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    city: text('city'),
    countryCode: text('country_code'),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('profiles_account_unique').on(t.accountId)],
);
export const factDefinitions = profile.table('fact_definitions', {
  factKey: text('fact_key').primaryKey(),
  valueKind: text('value_kind').notNull(),
  sensitivity: text('sensitivity').notNull(),
  allowedModes: text('allowed_modes').array().notNull(),
  defaultAudience: text('default_audience').notNull(),
  aiOnly: boolean('ai_only').notNull(),
  policyVersion: text('policy_version').notNull(),
});
export const profileFacts = profile.table(
  'profile_facts',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    factKey: text('fact_key')
      .notNull()
      .references(() => factDefinitions.factKey),
    state: text('state').notNull(),
    source: text('source').notNull(),
    valueJson: jsonb('value_json'),
    valueCiphertext: text('value_ciphertext'),
    valueNonce: text('value_nonce'),
    valueKeyId: text('value_key_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    version: integer('version').notNull(),
  },
  (t) => [
    uniqueIndex('profile_facts_profile_fact_unique').on(t.profileId, t.factKey),
    index('profile_facts_profile_idx').on(t.profileId),
  ],
);
export const factUses = profile.table(
  'fact_uses',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    factKey: text('fact_key')
      .notNull()
      .references(() => factDefinitions.factKey),
    mode: text('mode').notNull(),
    matchingEnabled: boolean('matching_enabled').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.factKey, t.mode] })],
);
export const factAudiences = profile.table(
  'fact_audiences',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    factKey: text('fact_key')
      .notNull()
      .references(() => factDefinitions.factKey),
    mode: text('mode').notNull(),
    audience: text('audience').notNull(),
    agePartition: text('age_partition').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.factKey, t.mode] })],
);
export const snapshots = profile.table(
  'snapshots',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    profileVersion: integer('profile_version').notNull(),
    contentHash: text('content_hash').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('profile_snapshots_profile_version_unique').on(t.profileId, t.profileVersion),
    uniqueIndex('profile_snapshots_profile_hash_unique').on(t.profileId, t.contentHash),
    index('profile_snapshots_profile_published_idx').on(t.profileId, t.publishedAt),
  ],
);
export const idempotencyKeys = profile.table(
  'idempotency_keys',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    idempotencyKeyDigest: text('idempotency_key_digest').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    resultJson: jsonb('result_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.idempotencyKeyDigest] })],
);
export const sensitiveAccessAudit = profile.table(
  'sensitive_access_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => accounts.id),
    subjectAccountId: uuid('subject_account_id')
      .notNull()
      .references(() => accounts.id),
    factKey: text('fact_key').notNull(),
    purpose: text('purpose').notNull(),
    decision: text('decision').notNull(),
    policyVersion: text('policy_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('profile_sensitive_audit_subject_idx').on(t.subjectAccountId, t.createdAt)],
);
