import { describe, expect, it } from 'vitest';
import { loadMigrationFile } from '@wai/db';
declare const WAI_MIGRATIONS_DIR: string;
describe('MCH-01 migration contract', () => {
  it('is fixed, reversible and account-cascade safe', () => {
    const migration = loadMigrationFile('0017_introductions.sql', WAI_MIGRATIONS_DIR);
    expect(migration.upSql).toContain('CREATE SCHEMA IF NOT EXISTS introductions');
    expect(migration.downSql).toContain('DROP');
    expect(migration.upSql).toContain('algorithm_version');
    expect(migration.upSql).toContain('ON DELETE CASCADE');
    expect(migration.downSql).toContain('DROP SCHEMA IF EXISTS introductions CASCADE');
  });
});
