import { describe, expect, it } from 'vitest';
import { loadMigrationFile } from '@wai/db';

declare const WAI_MIGRATIONS_DIR: string;

describe('CON-01 migration', () => {
  it('has the fixed 0009 up/down migration', async () => {
    const migration = loadMigrationFile('0009_connection.sql', WAI_MIGRATIONS_DIR);
    expect(migration.upSql).toContain('CREATE SCHEMA');
    expect(migration.downSql).toContain('DROP SCHEMA');
    expect(migration.upSql).toContain('connection_active_pair_unique');
    expect(migration.upSql).toContain('connection_block_invalidation');
    expect(migration.upSql).toContain("WHEN (NEW.state = 'active')");
    expect(migration.upSql).toContain('connection_transitions_append_only');
    expect(migration.upSql).toContain('pg_trigger_depth()');
    expect(migration.downSql).toContain('DROP SCHEMA IF EXISTS connection CASCADE');
  });
});
