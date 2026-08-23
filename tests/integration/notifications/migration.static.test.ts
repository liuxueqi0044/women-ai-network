import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMigrationFile } from '@wai/db';

describe('NTF-01 migration', () => {
  it('is the only module migration and reversible without MCH', () => {
    const migration = loadMigrationFile(
      '0018_notifications.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(migration.upSql).toContain('CREATE SCHEMA IF NOT EXISTS notifications');
    expect(migration.upSql).toContain('lease_fence');
    expect(migration.upSql).toContain('provider_attempts_append_only');
    expect(migration.upSql).not.toContain('0017');
    expect(migration.downSql).toContain('DROP SCHEMA IF EXISTS notifications');
  });
});
