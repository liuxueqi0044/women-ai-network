import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.resolve(__dirname, '../../../packages/db/migrations/0011_translation.sql'),
  'utf8',
);

describe('TRL-01 migration contract', () => {
  it('has reversible durable task/result/consent tables and closed guards', () => {
    expect(migration).toContain('-- +BEGIN UP');
    expect(migration).toContain('-- +BEGIN DOWN');
    expect(migration).toContain('CREATE TABLE translation.tasks');
    expect(migration).toContain('CREATE TABLE translation.results');
    expect(migration).toContain('CREATE TABLE translation.consents');
    expect(migration).toContain('CREATE TABLE translation.retry_wakeups');
    expect(migration).toContain('translation_consents_active_exact_unique');
    expect(migration).toContain("NEW.source_kind='private_letter'");
    expect(migration).toContain('l.current_revision=NEW.source_revision');
    expect(migration).toContain('task_initial_guard');
    expect(migration).toContain('consent_initial_guard');
    expect(migration).toContain('result_initial_guard');
    expect(migration).toContain('lease_until');
    expect(migration).toContain('DROP SCHEMA IF EXISTS translation');
  });

  it('stores only a digest of lease tokens', () => {
    expect(migration).toContain(
      "lease_token text CHECK (lease_token IS NULL OR lease_token ~ '^[0-9a-f]{64}$')",
    );
    expect(migration).not.toContain('lease_token uuid');
  });
});
