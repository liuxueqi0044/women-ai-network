import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMigrationFile } from '@wai/db';

describe('PVL-01 migration contract', () => {
  it('contains reversible encrypted delivery, binding, state, outbox and evidence guards', () => {
    const migration = loadMigrationFile(
      '0012_private_delivery.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(migration.upSql).toContain('CREATE SCHEMA IF NOT EXISTS private_delivery');
    expect(migration.upSql).toContain('snapshot_body_ciphertext');
    expect(migration.upSql).toContain('private_delivery.insert_guard');
    expect(migration.upSql).toContain('private_delivery.outbox_transition_guard');
    expect(migration.upSql).toContain('private_delivery.evidence_insert_guard');
    expect(migration.upSql).toContain('private delivery state transition is invalid');
    expect(migration.downSql).toContain('DROP SCHEMA IF EXISTS private_delivery');
  });
});
