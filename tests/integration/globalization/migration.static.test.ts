import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const sql = readFileSync(
  path.resolve(process.cwd(), 'packages/db/migrations/0015_globalization.sql'),
  'utf8',
);
describe('GLO-01 migration static contract', () => {
  it('is reversible and uses PostgreSQL timezone authority', () => {
    expect(sql).toContain('-- +BEGIN UP');
    expect(sql).toContain('-- +BEGIN DOWN');
    expect(sql).toContain('pg_timezone_names');
    expect(sql).toContain('preference_audit');
    expect(sql).toContain('audit_append_only');
    expect(sql).not.toMatch(/000[1-9]|001[0-4]/);
  });
});
