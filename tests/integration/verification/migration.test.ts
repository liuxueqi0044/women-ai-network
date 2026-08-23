import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMigrationFile } from '@wai/db';

describe('VER-01 migration', () => {
  it('has explicit reversible sections and contains no plaintext sensitive columns', () => {
    const file = loadMigrationFile(
      '0005_verification.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(file.upSql).toContain('CREATE SCHEMA IF NOT EXISTS verification');
    expect(file.downSql).toContain('DROP SCHEMA IF EXISTS verification');
    expect(file.upSql).not.toMatch(/raw_payload|birth_date\s+date|document_number|client_token/i);
  });
});
