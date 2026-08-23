import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.resolve(__dirname, '../../../packages/db/migrations/0007_media.sql'),
  'utf8',
);

describe('MED-01 migration contract', () => {
  it('has explicit reversible sections and all durable lifecycle tables', () => {
    expect(migration).toContain('-- +BEGIN UP');
    expect(migration).toContain('-- +BEGIN DOWN');
    for (const table of [
      'media.assets',
      'media.upload_intents',
      'media.processing_jobs',
      'media.renditions',
      'media.access_audit',
    ])
      expect(migration).toContain(`CREATE TABLE ${table}`);
    expect(migration).toContain('lease_token uuid');
    expect(migration).toContain('media_access_audit_append_only');
    expect(migration).toContain('invalid media state transition');
  });

  it('does not persist original filename, bytes, URL or access token columns', () => {
    const ddl = migration.replace(/--.*$/gm, '');
    expect(ddl).not.toMatch(/original[_ ]?filename|access[_ ]?token|signed[_ ]?url|bytea/i);
  });
});
