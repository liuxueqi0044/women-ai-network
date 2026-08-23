import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMigrationFile } from '@wai/db';

describe('PRF-01 migration', () => {
  it('is explicit, reversible and enforces privacy representation', () => {
    const file = loadMigrationFile(
      '0006_profile.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(file.upSql).toContain('CREATE SCHEMA IF NOT EXISTS profile');
    expect(file.downSql).toContain('DROP SCHEMA IF EXISTS profile CASCADE');
    expect(file.upSql).toContain('value_ciphertext');
    expect(file.upSql).toContain(
      'value_json IS NOT NULL)::integer + (value_ciphertext IS NOT NULL)::integer = 1',
    );
    expect(file.upSql).toContain('allowed_modes <@ ARRAY');
    expect(file.upSql).toContain('validate_fact_storage');
    expect(file.upSql).not.toMatch(/birth_date\s+date|document_number|exact_location|raw_payload/i);
  });
});
