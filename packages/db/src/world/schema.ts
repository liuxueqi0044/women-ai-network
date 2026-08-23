import { index, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const worldDiscovery = pgSchema('world_discovery');
export const discoveryIndex = worldDiscovery.table('discovery_index', {
  publicationId: uuid('publication_id').primaryKey(),
  letterId: uuid('letter_id').notNull(),
  revisionId: uuid('revision_id').notNull(),
  sourceHash: text('source_hash').notNull(),
  countryCode: text('country_code').notNull(),
  locale: text('locale').notNull(),
  topics: text('topics').array().notNull(),
  searchText: text('search_text').notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull(),
});
export const bookmarks = worldDiscovery.table(
  'bookmarks',
  {
    viewerId: uuid('viewer_id').notNull(),
    publicationId: uuid('publication_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.viewerId, table.publicationId] }),
    index('world_discovery_bookmarks_cursor_idx').on(
      table.viewerId,
      table.createdAt,
      table.publicationId,
    ),
  ],
);
