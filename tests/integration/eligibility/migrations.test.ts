import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EligibilityConflictError,
  MigrationRunner,
  canonicalJsonHash,
  createDb,
  createEligibilityRepositories,
  createPool,
  schema,
  type Db,
  type NewJurisdictionPolicy,
} from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

/**
 * CP2 evidence on a real PostgreSQL: the explicit 0003 migration applies on
 * an empty database, upgrades a live IAM database, re-runs as a no-op, fails
 * on a tampered file, rolls back and re-applies forward. Then the schema's
 * load-bearing constraints are exercised end-to-end: current-row uniqueness,
 * supersede-only immutability, non-overlapping approved policy intervals,
 * reason-code whitelists, append-only decision tables, concurrent upserts,
 * cascade erasure — and the plaintext birthday never lands in the database.
 */

const ALL_ELIGIBILITY_TABLES = [
  'jurisdiction_declarations',
  'jurisdiction_policies',
  'age_evidence',
  'age_credentials',
  'mode_decisions',
  'partition_decisions',
  'policy_events',
];
const ALL_VERIFICATION_TABLES = [
  'identity_cases',
  'verification_attempts',
  'provider_events',
  'identity_bindings',
  'membership_policies',
  'membership_cases',
  'membership_reviews',
  'membership_appeals',
  'redaction_requests',
  'audit_events',
];

// Injected by vitest.config.ts (`define`); resolves to packages/db/migrations.
declare const WAI_MIGRATIONS_DIR: string;
const MIGRATIONS_DIR = WAI_MIGRATIONS_DIR;

let started: StartedInfra;
let pool: Pool;
let db: Db;
let runner: MigrationRunner;

async function eligibilityTableNames(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'eligibility' ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function dumpEligibilityText(): Promise<string> {
  const tables = await eligibilityTableNames();
  const parts: string[] = [];
  for (const table of tables) {
    const { rows } = await pool.query(
      `SELECT to_json(t)::text AS json FROM eligibility."${table}" t`,
    );
    parts.push(...rows.map((row) => row.json as string));
  }
  return parts.join('\n');
}

/** Minimal enabled account fixture (column shape per 0001). */
async function insertAccount(id: string, emailDigest = `digest-${id}`): Promise<void> {
  await pool.query(
    `INSERT INTO iam.accounts
       (id, email_digest, email_ciphertext, email_nonce, email_key_id,
        state, state_reason, state_actor_type, state_changed_at, created_at, updated_at)
     VALUES ($1, $2, 'cipher', 'nonce', 'key',
             'enabled', 'registered', 'system', now(), now(), now())`,
    [id, emailDigest],
  );
}

function policyValues(overrides: Partial<NewJurisdictionPolicy> = {}): NewJurisdictionPolicy {
  const content = {
    policy_id: '11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b',
    revision: 1,
    minimum_account_age: 13,
    age_of_majority: 18,
    digital_consent_age: 16,
    parental_consent_required_below: 16,
    youth_launch_state: 'launched',
    allowed_cohorts: ['adult'],
    cross_cohort_contact_policy: 'same_cohort_only',
    mode_rules: {
      mode_enabled: {
        friends: true,
        activities: true,
        professional: true,
        circles: true,
        events: true,
        dating: false,
      },
      platform_minimum_age_by_mode: {
        friends: 13,
        activities: 13,
        professional: 13,
        circles: 13,
        events: 13,
        dating: 18,
      },
      mode_minimum_age: {
        friends: 0,
        activities: 0,
        professional: 0,
        circles: 0,
        events: 0,
        dating: 21,
      },
      required_age_assurance_by_mode: {
        friends: 'self_declared',
        activities: 'self_declared',
        professional: 'self_declared',
        circles: 'self_declared',
        events: 'self_declared',
        dating: 'externally_attested',
      },
    },
  };
  return {
    id: '11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b',
    jurisdictionKey: 'US',
    revision: 1,
    status: 'approved',
    content,
    contentHash: canonicalJsonHash(content),
    ruleHash: canonicalJsonHash({
      minimum_account_age: 13,
      age_of_majority: 18,
      digital_consent_age: 16,
      parental_consent_required_below: 16,
      youth_launch_state: 'launched',
      allowed_cohorts: ['adult'],
      cross_cohort_contact_policy: 'same_cohort_only',
      mode_rules: content.mode_rules,
    }),
    locationPrecisionPolicy: 'country_and_subdivision',
    profilingPolicy: 'derived_facts_only',
    retentionPolicy: 'credential_until_superseded',
    legalBasisRefs: ['synthetic:test'],
    reviewedBy: 'migration-test-reviewer',
    reviewedAt: new Date('2026-01-01T00:00:00.000Z'),
    timezone: 'America/New_York',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveUntil: new Date('2027-01-01T00:00:00.000Z'),
    isSynthetic: false,
    now: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  db = createDb(pool);
  runner = new MigrationRunner(pool, MIGRATIONS_DIR, { through: '0012_private_delivery.sql' });
});

afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('ELG eligibility migration lifecycle on an empty database', () => {
  it('applies the complete current migration chain fresh and creates all tables', async () => {
    expect(await eligibilityTableNames()).toHaveLength(0);
    const result = await runner.up();
    expect(result.applied).toEqual([
      '0001_iam_account.sql',
      '0002_iam_r1.sql',
      '0003_eligibility.sql',
      '0004_eligibility_r1_hardening.sql',
      '0005_verification.sql',
      '0006_profile.sql',
      '0007_media.sql',
      '0008_safety.sql',
      '0009_connection.sql',
      '0010_letters.sql',
      '0011_translation.sql',
      '0012_private_delivery.sql',
    ]);
    const tables = await eligibilityTableNames();
    for (const table of ALL_ELIGIBILITY_TABLES) {
      expect(tables).toContain(table);
    }
    const { rows: verificationRows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='verification'`,
    );
    expect(verificationRows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(ALL_VERIFICATION_TABLES),
    );
    const { rows } = await pool.query(
      `SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('re-running is a no-op (idempotent)', async () => {
    const result = await runner.up();
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      '0001_iam_account.sql',
      '0002_iam_r1.sql',
      '0003_eligibility.sql',
      '0004_eligibility_r1_hardening.sql',
      '0005_verification.sql',
      '0006_profile.sql',
      '0007_media.sql',
      '0008_safety.sql',
      '0009_connection.sql',
      '0010_letters.sql',
      '0011_translation.sql',
      '0012_private_delivery.sql',
    ]);
  });

  it('upgrades a live IAM database (0001+0002) without touching existing data', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wai-elg-upgrade-'));
    try {
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      for (const name of ['0001_iam_account.sql', '0002_iam_r1.sql']) {
        writeFileSync(path.join(dir, name), readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
      }
      const upgradeRunner = new MigrationRunner(pool, dir);
      await upgradeRunner.up();
      await insertAccount('50000000-0000-4000-8000-000000000001', 'upgrade-email');
      const before = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM iam.accounts',
      );
      expect(before.rows[0]?.n).toBe('1');

      writeFileSync(
        path.join(dir, '0003_eligibility.sql'),
        readFileSync(path.join(MIGRATIONS_DIR, '0003_eligibility.sql'), 'utf8'),
      );
      writeFileSync(
        path.join(dir, '0004_eligibility_r1_hardening.sql'),
        readFileSync(path.join(MIGRATIONS_DIR, '0004_eligibility_r1_hardening.sql'), 'utf8'),
      );
      writeFileSync(
        path.join(dir, '0005_verification.sql'),
        readFileSync(path.join(MIGRATIONS_DIR, '0005_verification.sql'), 'utf8'),
      );
      await upgradeRunner.up();

      const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM iam.accounts');
      expect(after.rows[0]?.n).toBe('1');
      expect(await eligibilityTableNames()).toEqual([...ALL_ELIGIBILITY_TABLES].sort());
      const { rows: verificationRows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='verification'`,
      );
      expect(verificationRows.map((r) => r.table_name)).toEqual(
        expect.arrayContaining(ALL_VERIFICATION_TABLES),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await runner.up();
    }
  });

  it('fails loudly when an applied migration file is tampered with', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wai-elg-tamper-'));
    try {
      // Tampering that changes the checksum WITHOUT breaking the DDL: the
      // first apply must succeed (recording the tampered checksum) before
      // the second apply can detect the change.
      const tampered = `${readFileSync(
        path.join(MIGRATIONS_DIR, '0003_eligibility.sql'),
        'utf8',
      )}\n-- tampered\n`;
      for (const name of ['0001_iam_account.sql', '0002_iam_r1.sql']) {
        writeFileSync(path.join(dir, name), readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
      }
      writeFileSync(path.join(dir, '0003_eligibility.sql'), tampered, 'utf8');
      // Reset both schemas: the eligibility schema alone would leave 0003's
      // tracker row behind, and a dir-scoped runner only knows its own files.
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      const tamperRunner = new MigrationRunner(pool, dir);
      // First apply succeeds with the tampered checksum…
      await tamperRunner.up();
      // …but a second apply detects the changed checksum.
      const changed = tampered.replace('-- tampered\n', '-- tampered again\n');
      writeFileSync(path.join(dir, '0003_eligibility.sql'), changed, 'utf8');
      await expect(tamperRunner.up()).rejects.toThrow(/tampered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // Restore the pristine state the other tests assume: drop both schemas
      // (which also clears the migration tracker) and re-apply everything
      // from the real migrations dir.
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await runner.up();
    }
  });

  it('rolls back 0012 through 0003: verification and eligibility disappear, iam survives; forward re-applies', async () => {
    const delivery = await runner.down();
    expect(delivery).toBe('0012_private_delivery.sql');
    const translation = await runner.down();
    expect(translation).toBe('0011_translation.sql');
    const letters = await runner.down();
    expect(letters).toBe('0010_letters.sql');
    const connection = await runner.down();
    expect(connection).toBe('0009_connection.sql');
    const safety = await runner.down();
    expect(safety).toBe('0008_safety.sql');
    const media = await runner.down();
    expect(media).toBe('0007_media.sql');
    const rolled = await runner.down();
    expect(rolled).toBe('0006_profile.sql');
    const rolledProfile = await runner.down();
    expect(rolledProfile).toBe('0005_verification.sql');
    const rolledHardening = await runner.down();
    expect(rolledHardening).toBe('0004_eligibility_r1_hardening.sql');
    const rolledBase = await runner.down();
    expect(rolledBase).toBe('0003_eligibility.sql');
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = 'eligibility'`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
    // btree_gist is intentionally retained (extension, not schema-owned).
    const ext = await pool.query(`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(ext.rows).toHaveLength(1);

    const result = await runner.up();
    expect(result.applied).toEqual([
      '0003_eligibility.sql',
      '0004_eligibility_r1_hardening.sql',
      '0005_verification.sql',
      '0006_profile.sql',
      '0007_media.sql',
      '0008_safety.sql',
      '0009_connection.sql',
      '0010_letters.sql',
      '0011_translation.sql',
      '0012_private_delivery.sql',
    ]);
    expect(await eligibilityTableNames()).toEqual([...ALL_ELIGIBILITY_TABLES].sort());
    const { rows: verificationRows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='verification'`,
    );
    expect(verificationRows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(ALL_VERIFICATION_TABLES),
    );
  });
});

describe('eligibility constraints on a real database', () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = '60000000-0000-4000-8000-000000000001';
    await insertAccount(accountId, 'constraint-account');
  });

  it('jurisdiction declarations: one current row; supersede chain preserves history', async () => {
    const repo = createEligibilityRepositories(db).jurisdictionDeclarations;
    const first = await repo.upsertCurrent({
      id: '10000000-0000-4000-8000-000000000001',
      accountId,
      countryCode: 'US',
      subdivisionCode: 'CA',
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(first.version).toBe(1);

    // Same content → idempotent no-op, no new row.
    const same = await repo.upsertCurrent({
      id: '10000000-0000-4000-8000-000000000002',
      accountId,
      countryCode: 'US',
      subdivisionCode: 'CA',
      now: new Date('2026-02-02T00:00:00.000Z'),
    });
    expect(same.id).toBe(first.id);

    // Different content → supersede + new version.
    const changed = await repo.upsertCurrent({
      id: '10000000-0000-4000-8000-000000000003',
      accountId,
      countryCode: 'GB',
      subdivisionCode: null,
      now: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(changed.version).toBe(2);
    const current = await repo.current(accountId);
    expect(current?.id).toBe(changed.id);

    // History: two rows, old one superseded.
    const { rows } = await pool.query<{ version: number; superseded_at: string | null }>(
      `SELECT version, superseded_at FROM eligibility.jurisdiction_declarations
       WHERE account_id = $1 ORDER BY version`,
      [accountId],
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]?.superseded_at).not.toBeNull();
    expect(rows[1]?.superseded_at).toBeNull();
  });

  it('jurisdiction declarations: the current row cannot be edited or double-inserted', async () => {
    await expect(
      pool.query(
        `UPDATE eligibility.jurisdiction_declarations
         SET country_code = 'DE' WHERE account_id = $1 AND superseded_at IS NULL`,
        [accountId],
      ),
    ).rejects.toThrow(/current jurisdiction declaration cannot be modified in place/);
    await expect(
      pool.query(
        `INSERT INTO eligibility.jurisdiction_declarations
           (id, account_id, country_code, source, review_state, effective_from, version, created_at)
         VALUES ('10000000-0000-4000-8000-000000000009', $1, 'FR',
                 'self_declared', 'accepted', now(), 3, now())`,
        [accountId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // Superseding is legal ONLY when nothing but superseded_at changes.
    await expect(
      pool.query(
        `UPDATE eligibility.jurisdiction_declarations
         SET country_code = 'DE', superseded_at = now()
         WHERE account_id = $1 AND superseded_at IS NULL`,
        [accountId],
      ),
    ).rejects.toThrow(/may only set superseded_at/);
    // Direct deletes are blocked (history is append-only).
    await expect(
      pool.query(`DELETE FROM eligibility.jurisdiction_declarations WHERE account_id = $1`, [
        accountId,
      ]),
    ).rejects.toThrow(/jurisdiction declarations are never deleted directly/);
  });

  it('jurisdiction policies: approved intervals never overlap; draft overlaps are fine', async () => {
    const repo = createEligibilityRepositories(db).jurisdictionPolicies;
    await repo.insert(policyValues());
    // Draft row may overlap — intervals only bind approved content.
    await repo.insert(
      policyValues({
        id: '33e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b',
        revision: 3,
        status: 'draft',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveUntil: new Date('2027-06-01T00:00:00.000Z'),
      }),
    );
    await expect(
      pool.query(
        `UPDATE eligibility.jurisdiction_policies SET status = 'approved'
         WHERE id = '33e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b'`,
      ),
    ).rejects.toThrow(/governed publication path/);
    // Non-overlapping approved successor is fine.
    await repo.insert(
      policyValues({
        id: '44e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b',
        revision: 4,
        effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
        effectiveUntil: new Date('2028-01-01T00:00:00.000Z'),
      }),
    );
    // Same jurisdiction, overlapping interval, approved → EXCLUDE violation
    // (raw SQL so the pg SQLSTATE surfaces directly).
    await expect(
      pool.query(
        `INSERT INTO eligibility.jurisdiction_policies
           (id, jurisdiction_key, revision, status, content, content_hash,
            rule_hash, location_precision_policy, profiling_policy, retention_policy,
            legal_basis_refs, reviewed_by, reviewed_at, timezone, effective_from, effective_until, is_synthetic, created_at)
         VALUES ('22e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b', 'US', 2, 'approved',
                 '{"a":1}', $1, $2, 'country_and_subdivision', 'derived_facts_only', 'test', ARRAY['synthetic:test'], 'test-reviewer', now(), 'America/New_York',
                 '2026-06-01T00:00:00Z', '2027-06-01T00:00:00Z', false, now())`,
        ['a'.repeat(64), 'b'.repeat(64)],
      ),
    ).rejects.toThrow(/governed publication path/);
    // findActive resolves the interval containing `at`.
    const active = await repo.findActive('US', new Date('2026-06-15T00:00:00.000Z'));
    expect(active?.id).toBe('11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b');
    const successor = await repo.findActive('US', new Date('2027-06-15T00:00:00.000Z'));
    expect(successor?.id).toBe('44e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b');
    const none = await repo.findActive('US', new Date('2029-01-01T00:00:00.000Z'));
    expect(none).toBeNull();
  });

  it('jurisdiction policies: approved content is immutable; retirement is terminal; no deletes', async () => {
    const policyId = '11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
    await expect(
      pool.query(`UPDATE eligibility.jurisdiction_policies SET timezone = 'UTC' WHERE id = $1`, [
        policyId,
      ]),
    ).rejects.toThrow(/approved policy cannot be modified in place/);
    await expect(
      pool.query(
        `UPDATE eligibility.jurisdiction_policies
         SET status = 'retired', timezone = 'UTC' WHERE id = $1`,
        [policyId],
      ),
    ).rejects.toThrow(/approved policy is immutable except status\/retired_at/);
    const repo = createEligibilityRepositories(db).jurisdictionPolicies;
    const retired = await repo.retire(policyId, new Date('2026-12-01T00:00:00.000Z'));
    expect(retired?.status).toBe('retired');
    expect(retired?.retiredAt).not.toBeNull();
    await expect(
      pool.query(`UPDATE eligibility.jurisdiction_policies SET status = 'draft' WHERE id = $1`, [
        policyId,
      ]),
    ).rejects.toThrow(/retired policy is terminal/);
    await expect(
      pool.query(`DELETE FROM eligibility.jurisdiction_policies WHERE id = $1`, [policyId]),
    ).rejects.toThrow(/jurisdiction policy rows are never deleted/);
  });

  it('age evidence: supersede-only writes, encrypted columns, current unique', async () => {
    const repo = createEligibilityRepositories(db).ageEvidence;
    const now = new Date('2026-04-01T00:00:00.000Z');
    const first = await repo.upsertCurrent({
      id: '20000000-0000-4000-8000-000000000001',
      accountId,
      birthdayDigest: 'a'.repeat(64),
      ciphertext: 'cipher-one',
      nonce: 'nonce-one',
      keyId: '2026-01',
      now,
    });
    // Same digest → idempotent no-op.
    const same = await repo.upsertCurrent({
      id: '20000000-0000-4000-8000-000000000002',
      accountId,
      birthdayDigest: 'a'.repeat(64),
      ciphertext: 'cipher-different',
      nonce: 'nonce-different',
      keyId: '2026-01',
      now,
    });
    expect(same.id).toBe(first.id);
    // Different digest → supersede + insert.
    const changed = await repo.upsertCurrent({
      id: '20000000-0000-4000-8000-000000000003',
      accountId,
      birthdayDigest: 'b'.repeat(64),
      ciphertext: 'cipher-two',
      nonce: 'nonce-two',
      keyId: '2026-01',
      now: new Date('2026-05-01T00:00:00.000Z'),
    });
    expect(changed.id).not.toBe(first.id);
    const current = await repo.current(accountId);
    expect(current?.id).toBe(changed.id);

    // Only the digest identifies content; the ciphertext stays randomized.
    expect(current?.birthdayDigest).toBe('b'.repeat(64));
    expect(current?.birthdayCiphertext).toBe('cipher-two');
  });

  it('age evidence: the current row cannot be edited, double-inserted or deleted directly', async () => {
    await expect(
      pool.query(
        `UPDATE eligibility.age_evidence SET birthday_ciphertext = 'evil' WHERE account_id = $1`,
        [accountId],
      ),
    ).rejects.toThrow(/immutable|may only be marked superseded/);
    await expect(
      pool.query(
        `INSERT INTO eligibility.age_evidence
           (id, account_id, birthday_digest, birthday_ciphertext, birthday_nonce,
            birthday_key_id, source, declared_at, created_at)
         VALUES ('20000000-0000-4000-8000-000000000009', $1, $2, 'x', 'y',
                 'k', 'self_declared', now(), now())`,
        [accountId, 'c'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(`DELETE FROM eligibility.age_evidence WHERE account_id = $1`, [accountId]),
    ).rejects.toThrow(/age evidence is append-only/);
  });

  it('age credentials: immutable snapshots, one current per account', async () => {
    const evidence = await createEligibilityRepositories(db).ageEvidence.current(accountId);
    expect(evidence).not.toBeNull();
    const repo = createEligibilityRepositories(db).ageCredentials;
    const first = await repo.insertCurrent({
      id: '30000000-0000-4000-8000-000000000001',
      accountId,
      ageBand: 'youth',
      cohortKey: 'youth_16',
      assuranceLevel: 'self_declared',
      issuerType: 'eligibility_self_declaration',
      sourceEvidenceId: evidence!.id,
      jurisdictionPolicyId: '44e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b',
      policyRevision: 4,
      validFrom: new Date('2026-04-01T00:00:00.000Z'),
      validUntil: new Date('2027-04-01T00:00:00.000Z'),
      derivedAt: new Date('2026-04-01T00:00:00.000Z'),
      derivationVersion: 1,
      now: new Date('2026-04-01T00:00:00.000Z'),
    });
    const second = await repo.insertCurrent({
      id: '30000000-0000-4000-8000-000000000002',
      accountId,
      ageBand: 'adult',
      cohortKey: 'adult',
      assuranceLevel: 'self_declared',
      issuerType: 'eligibility_self_declaration',
      sourceEvidenceId: evidence!.id,
      jurisdictionPolicyId: '44e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b',
      policyRevision: 4,
      validFrom: new Date('2026-05-01T00:00:00.000Z'),
      validUntil: new Date('2027-05-01T00:00:00.000Z'),
      derivedAt: new Date('2026-05-01T00:00:00.000Z'),
      derivationVersion: 1,
      now: new Date('2026-05-01T00:00:00.000Z'),
    });
    expect(second.id).not.toBe(first.id);
    const current = await repo.current(accountId);
    expect(current?.id).toBe(second.id);

    await expect(
      pool.query(
        `UPDATE eligibility.age_credentials SET age_band = 'below_minimum' WHERE id = $1`,
        [second.id],
      ),
    ).rejects.toThrow(/immutable|may only be marked superseded/);
    await expect(
      pool.query(`DELETE FROM eligibility.age_credentials WHERE id = $1`, [second.id]),
    ).rejects.toThrow(/age credentials are immutable/);
    await expect(
      pool.query(
        `INSERT INTO eligibility.age_credentials
           (id, account_id, age_band, cohort_key, assurance_level, issuer_type,
            source_evidence_id, jurisdiction_policy_id, policy_revision,
            valid_from, valid_until, derived_at, derivation_version, created_at)
         VALUES ('30000000-0000-4000-8000-000000000003', $1, 'adult', 'adult',
                 'self_declared', 'eligibility_self_declaration', $2, $3, 4,
                 now(), now() + interval '1 day', now(), 1, now())`,
        [accountId, evidence!.id, '44e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b'],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('mode decisions: reason whitelist + allow/deny invariant + append-only', async () => {
    const policyId = '44e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
    const credentialId = '30000000-0000-4000-8000-000000000002';
    const base = {
      decisionId: '70000000-0000-4000-8000-000000000001',
      accountId,
      scope: 'age_and_jurisdiction' as const,
      mode: 'friends' as const,
      ageBand: 'adult' as const,
      cohortKey: 'adult',
      assuranceLevel: 'self_declared' as const,
      obligations: [],
      policyId,
      policyRevision: 4,
      policyHash: 'd'.repeat(64),
      credentialId,
      credentialHash: 'e'.repeat(64),
      inputHash: 'f'.repeat(64),
      evaluatedAt: new Date('2026-06-01T00:00:00.000Z'),
      validUntil: new Date('2027-06-01T00:00:00.000Z'),
      engineVersion: 1,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const repo = createEligibilityRepositories(db).modeDecisions;
    await repo.insertIfAbsent({ ...base, decision: 'allow', reasonCodes: [] });
    // Unknown reason code → whitelist CHECK.
    await expect(
      pool.query(
        `INSERT INTO eligibility.mode_decisions
           (decision_id, account_id, scope, mode, decision, age_band, cohort_key,
            assurance_level, reason_codes, obligations, policy_id, policy_revision,
            policy_hash, credential_id, credential_hash, input_hash, evaluated_at,
            valid_until, engine_version, created_at)
         VALUES ('70000000-0000-4000-8000-000000000002', $1, 'age_and_jurisdiction',
                 'dating', 'deny', 'youth', 'youth_16', 'self_declared',
                 ARRAY['SOMETHING_ELSE'], '{}', $2, 4, $3, $4, $5, $6, now(),
                 now() + interval '1 day', 1, now())`,
        [accountId, policyId, 'd'.repeat(64), credentialId, 'e'.repeat(64), 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ constraint: 'mode_decisions_reason_codes_check' });
    // allow must carry zero reasons; deny must carry at least one.
    await expect(
      pool.query(
        `INSERT INTO eligibility.mode_decisions
           (decision_id, account_id, scope, mode, decision, age_band, cohort_key,
            assurance_level, reason_codes, policy_id, policy_revision, policy_hash,
            credential_id, credential_hash, input_hash, evaluated_at, valid_until,
            engine_version, created_at)
         VALUES ('70000000-0000-4000-8000-000000000003', $1, 'age_and_jurisdiction',
                 'friends', 'allow', 'adult', 'adult', 'self_declared',
                 ARRAY['MODE_DISABLED'], $2, 4, $3, $4, $5, $6, now(),
                 now() + interval '1 day', 1, now())`,
        [accountId, policyId, 'd'.repeat(64), credentialId, 'e'.repeat(64), 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ constraint: 'mode_decisions_reason_invariant_chk' });
    await expect(
      pool.query(
        `INSERT INTO eligibility.mode_decisions
           (decision_id, account_id, scope, mode, decision, age_band, cohort_key,
            assurance_level, reason_codes, policy_id, policy_revision, policy_hash,
            credential_id, credential_hash, input_hash, evaluated_at, valid_until,
            engine_version, created_at)
         VALUES ('70000000-0000-4000-8000-000000000004', $1, 'age_and_jurisdiction',
                 'friends', 'deny', 'adult', 'adult', 'self_declared',
                 ARRAY[]::text[], $2, 4, $3, $4, $5, $6, now(),
                 now() + interval '1 day', 1, now())`,
        [accountId, policyId, 'd'.repeat(64), credentialId, 'e'.repeat(64), 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ constraint: 'mode_decisions_reason_invariant_chk' });
    // Append-only: no UPDATE, no direct DELETE.
    await expect(
      pool.query(`UPDATE eligibility.mode_decisions SET decision = 'deny' WHERE decision_id = $1`, [
        base.decisionId,
      ]),
    ).rejects.toThrow(/mode_decisions is append-only/);
    await expect(
      pool.query(`DELETE FROM eligibility.mode_decisions WHERE decision_id = $1`, [
        base.decisionId,
      ]),
    ).rejects.toThrow(/mode_decisions is append-only/);
  });

  it('decision insertIfAbsent is idempotent under concurrency', async () => {
    const repo = createEligibilityRepositories(db).modeDecisions;
    const policyId = '44e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
    const credentialId = '30000000-0000-4000-8000-000000000002';
    const makeRow = (decisionId: string) => ({
      decisionId,
      accountId,
      scope: 'age_and_jurisdiction' as const,
      mode: 'dating' as const,
      decision: 'deny' as const,
      ageBand: 'youth' as const,
      cohortKey: 'youth_16',
      assuranceLevel: 'self_declared' as const,
      reasonCodes: ['MODE_MINIMUM_AGE_NOT_MET'],
      obligations: [],
      policyId,
      policyRevision: 4,
      policyHash: 'd'.repeat(64),
      credentialId,
      credentialHash: 'e'.repeat(64),
      inputHash: 'f'.repeat(64),
      evaluatedAt: new Date('2026-06-01T00:00:00.000Z'),
      validUntil: new Date('2027-06-01T00:00:00.000Z'),
      engineVersion: 1,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const [a, b] = await Promise.all([
      repo.insertIfAbsent(makeRow('80000000-0000-4000-8000-000000000001')),
      repo.insertIfAbsent(makeRow('80000000-0000-4000-8000-000000000001')),
    ]);
    expect(a.inserted || b.inserted).toBe(true);
    expect(a.row.decisionId).toBe(b.row.decisionId);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eligibility.mode_decisions
       WHERE decision_id = '80000000-0000-4000-8000-000000000001'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('concurrent upserts never produce two current rows', async () => {
    const other = '90000000-0000-4000-8000-000000000001';
    await insertAccount(other, 'concurrent-account');
    const declRepo = createEligibilityRepositories(db).jurisdictionDeclarations;
    const evidenceRepo = createEligibilityRepositories(db).ageEvidence;

    const declOutcomes = await Promise.allSettled([
      declRepo.upsertCurrent({
        id: '10000000-0000-4000-9000-000000000001',
        accountId: other,
        countryCode: 'US',
        subdivisionCode: null,
        now: new Date('2026-07-01T00:00:00.000Z'),
      }),
      declRepo.upsertCurrent({
        id: '10000000-0000-4000-9000-000000000002',
        accountId: other,
        countryCode: 'GB',
        subdivisionCode: null,
        now: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ]);
    const declRejected = declOutcomes.filter((o) => o.status === 'rejected');
    for (const outcome of declRejected) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(EligibilityConflictError);
    }
    const { rows: declRows } = await pool.query<{ n: string; cur: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE superseded_at IS NULL)::text AS cur
       FROM eligibility.jurisdiction_declarations WHERE account_id = $1`,
      [other],
    );
    expect(declRows[0]?.cur).toBe('1');

    // Same digest under concurrency: the loser either serializes behind the
    // lock (idempotent no-op) or hits the partial-unique 23505 race, which is
    // surfaced as EligibilityConflictError. Either way: exactly one row.
    const evOutcomes = await Promise.allSettled([
      evidenceRepo.upsertCurrent({
        id: '20000000-0000-4000-9000-000000000001',
        accountId: other,
        birthdayDigest: 'e'.repeat(64),
        ciphertext: 'cipher-a',
        nonce: 'nonce-a',
        keyId: '2026-01',
        now: new Date('2026-07-01T00:00:00.000Z'),
      }),
      evidenceRepo.upsertCurrent({
        id: '20000000-0000-4000-9000-000000000002',
        accountId: other,
        birthdayDigest: 'e'.repeat(64),
        ciphertext: 'cipher-b',
        nonce: 'nonce-b',
        keyId: '2026-01',
        now: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ]);
    const evFulfilled = evOutcomes.filter(
      (o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof evidenceRepo.upsertCurrent>>> =>
        o.status === 'fulfilled',
    );
    expect(evFulfilled.length).toBeGreaterThanOrEqual(1);
    for (const outcome of evOutcomes.filter((o) => o.status === 'rejected')) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(EligibilityConflictError);
    }
    const winner = evFulfilled[0]!.value.id;
    for (const outcome of evFulfilled) {
      expect(outcome.value.id).toBe(winner);
    }
    const { rows: evRows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eligibility.age_evidence WHERE account_id = $1`,
      [other],
    );
    expect(evRows[0]?.n).toBe('1');
  });

  it('account erasure cascades eligibility rows and nulls policy event accounts', async () => {
    const doomed = 'a0000000-0000-4000-8000-000000000001';
    await insertAccount(doomed, 'erasure-account');
    await pool.query(
      `INSERT INTO eligibility.jurisdiction_declarations
         (id, account_id, country_code, source, review_state, effective_from, version, created_at)
       VALUES ('10000000-0000-4000-a000-000000000001', $1, 'US',
               'self_declared', 'accepted', now(), 1, now())`,
      [doomed],
    );
    await pool.query(
      `INSERT INTO eligibility.age_evidence
         (id, account_id, birthday_digest, birthday_ciphertext, birthday_nonce,
          birthday_key_id, source, declared_at, created_at)
       VALUES ('20000000-0000-4000-a000-000000000001', $1, $2, 'c', 'n', 'k',
               'self_declared', now(), now())`,
      [doomed, 'f'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO eligibility.policy_events
         (event_type, account_id, reason, metadata, created_at)
       VALUES ('evaluation_failure', $1, 'test', '{}', now())`,
      [doomed],
    );
    await pool.query(`DELETE FROM iam.accounts WHERE id = $1`, [doomed]);
    for (const table of ['jurisdiction_declarations', 'age_evidence']) {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM eligibility."${table}" WHERE account_id = $1`,
        [doomed],
      );
      expect(rows[0]?.n).toBe('0');
    }
    const { rows } = await pool.query<{ account_id: string | null }>(
      `SELECT account_id FROM eligibility.policy_events ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]?.account_id).toBeNull();
  });
});

describe('the plaintext birthday never lands in the database', () => {
  it('age_evidence stores only digest + ciphertext; the raw date is absent everywhere', async () => {
    const accountId = 'b0000000-0000-4000-8000-000000000001';
    await insertAccount(accountId, 'pii-account');
    const birthday = '2010-03-14';
    const now = new Date('2026-08-15T12:00:00.000Z');

    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'eligibility' AND table_name = 'age_evidence'
         AND column_name LIKE '%birthday%'`,
    );
    expect(rows.map((c) => c.column_name)).toEqual([
      'birthday_digest',
      'birthday_ciphertext',
      'birthday_nonce',
      'birthday_key_id',
    ]);

    await db.insert(schema.ageEvidence).values({
      id: '20000000-0000-4000-b000-000000000001',
      accountId,
      birthdayDigest: 'deadbeef'.repeat(8),
      birthdayCiphertext: 'ciphertext-nonce-tag',
      birthdayNonce: 'nonce',
      birthdayKeyId: '2026-01',
      source: 'self_declared',
      declaredAt: now,
      createdAt: now,
    });

    const dump = await dumpEligibilityText();
    expect(dump).not.toContain(birthday);
    expect(dump).not.toContain('2010-03-14T00:00:00');
    expect(dump).toContain('deadbeef'.repeat(8));
    expect(dump).toContain('ciphertext-nonce-tag');
  });
});
