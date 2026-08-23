import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMigrationFile } from '@wai/db';

describe('CIR-01 migration', () => {
  it('is additive, encrypted, reversible, and durable', () => {
    const migration = loadMigrationFile(
      '0019_circles.sql',
      path.resolve(process.cwd(), 'packages/db/migrations'),
    );
    expect(migration.upSql).toContain('CREATE SCHEMA IF NOT EXISTS circles');
    expect(migration.upSql).toContain('description_ciphertext');
    expect(migration.upSql).toContain('body_ciphertext');
    expect(migration.upSql).toContain('notification_handoff');
    expect(migration.upSql).toContain('append_only_audit');
    expect(migration.upSql).toContain("scope_kind IN ('online','country','city')");
    expect(migration.upSql).toContain('topic_catalog_version');
    expect(migration.upSql).toContain("'circle','note'");
    expect(migration.upSql).toContain("'circles','event_visibility'");
    expect(migration.upSql).toContain('partition_decisions_capability_check');
    expect(migration.upSql).toContain('circles_membership_account_active_cursor_idx');
    expect(migration.upSql).toContain('circles_membership_circle_active_cursor_idx');
    expect(migration.upSql).toContain('circles_pending_join_cursor_idx');
    expect(migration.downSql).toContain('DROP SCHEMA IF EXISTS circles');
  });
});
