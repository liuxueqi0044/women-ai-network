import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMigrationFile } from '@wai/db';
describe('SAF-01 migration', () => {
  it('has fixed lifecycle and append-only guards', () => {
    const m = loadMigrationFile(
      '0008_safety.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(m.upSql).toContain('CREATE SCHEMA IF NOT EXISTS safety');
    expect(m.upSql).toContain('safety.append_only_guard');
    expect(m.downSql).toContain('DROP SCHEMA IF EXISTS safety');
  });
});
