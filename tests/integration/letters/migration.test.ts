import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMigrationFile } from '@wai/db';

describe('LTR-01 migration scaffold', () => {
  it('has the fixed reversible migration sections', () => {
    const migration = loadMigrationFile(
      '0010_letters.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(migration.upSql).toContain('CREATE SCHEMA IF NOT EXISTS letters');
    expect(migration.upSql).toContain('CREATE TABLE letters.letter_revisions');
    expect(migration.upSql.match(/UNIQUE\(letter_id, revision\)/g)).toHaveLength(1);
    expect(migration.upSql).toContain('letters_owner_cursor_idx');
    expect(migration.upSql).toContain('publication revision binding is invalid');
    expect(migration.upSql).toContain('letter_identity_transition_guard');
    expect(migration.downSql).toContain('DROP SCHEMA IF EXISTS letters');
  });
});

describe('WLD-01 migration scaffold', () => {
  it('has the fixed reversible discovery sections', () => {
    const migration = loadMigrationFile(
      '0013_world_discovery.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(migration.upSql).toContain('CREATE SCHEMA IF NOT EXISTS world_discovery');
    expect(migration.upSql).toContain('CREATE TABLE world_discovery.discovery_index');
    expect(migration.upSql).toContain('CREATE TABLE world_discovery.bookmarks');
    expect(migration.upSql).toContain('pg_trgm');
    expect(migration.downSql).toContain('DROP SCHEMA IF EXISTS world_discovery');
  });
});
