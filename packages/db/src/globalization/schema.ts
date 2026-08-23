import {
  bigserial,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { GlobalizationPreferences } from '@wai/contracts';
import { accounts } from '../schema.js';

export const globalization = pgSchema('globalization');
export const accountPreferences = globalization.table('account_preferences', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  uiLocale: text('ui_locale').notNull(),
  contentLocales: text('content_locales').array().notNull(),
  timeZone: text('time_zone').notNull(),
  hourCycle: text('hour_cycle').notNull(),
  weekStart: smallint('week_start').notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const preferenceIdempotency = globalization.table(
  'preference_idempotency',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    idempotencyKeyDigest: text('idempotency_key_digest').notNull(),
    requestDigest: text('request_digest').notNull(),
    responseJson: jsonb('response_json').$type<GlobalizationPreferences>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.idempotencyKeyDigest] })],
);
export const preferenceAudit = globalization.table('preference_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  uiLocaleOld: text('ui_locale_old'),
  uiLocaleNew: text('ui_locale_new').notNull(),
  contentLocalesOldHash: text('content_locales_old_hash'),
  contentLocalesNewHash: text('content_locales_new_hash').notNull(),
  timeZoneOldHash: text('time_zone_old_hash'),
  timeZoneNewHash: text('time_zone_new_hash').notNull(),
  hourCycleOld: text('hour_cycle_old'),
  hourCycleNew: text('hour_cycle_new').notNull(),
  weekStartOld: smallint('week_start_old'),
  weekStartNew: smallint('week_start_new').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
