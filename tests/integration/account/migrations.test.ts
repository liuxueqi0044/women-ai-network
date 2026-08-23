import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner, createDb, createPool, hmacDigest, schema, type Db } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

/**
 * CP2 evidence: the explicit SQL migration runs on an EMPTY real Postgres,
 * re-running is a no-op, a tampered applied file fails loudly, rollback
 * removes the schemas, forward re-applies them — and PII (email, password,
 * session token, TOTP secret, recovery code) never exists in plaintext
 * anywhere in the database.
 *
 * The chain under test is the complete 0001 through 0009 migration chain:
 * runner applies every pending file in the shared migrations directory in
 * lexical order, so the shared-database choreography below keeps all three
 * schemas in step. The upgrade-path fixtures still copy only the 0001/0002
 * files into a temp directory — that is the IAM upgrade scenario.
 */

const EMAIL = 'member@example.invalid';
const PASSWORD = 'correct horse battery staple';
const SESSION_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const RECOVERY_CODE = 'W2K4-9PQR-3M5N-7X8Z';

const ALL_TABLES = [
  'accounts',
  'password_credentials',
  'devices',
  'sessions',
  'mfa_factors',
  'mfa_challenges',
  'recovery_codes',
  'account_state_transitions',
  'security_events',
];

// Injected by vitest.config.ts (`define`); resolves to packages/db/migrations.
declare const WAI_MIGRATIONS_DIR: string;
const MIGRATIONS_DIR = WAI_MIGRATIONS_DIR;

let started: StartedInfra;
let pool: Pool;
let db: Db;
let runner: MigrationRunner;

async function tableNames(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'iam' ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function dumpAllText(): Promise<string> {
  const tables = await tableNames();
  const parts: string[] = [];
  for (const table of tables) {
    if (table === 'schema_migrations') {
      continue;
    }
    const { rows } = await pool.query(`SELECT to_json(t)::text AS json FROM iam."${table}" t`);
    parts.push(...rows.map((row) => row.json as string));
  }
  return parts.join('\n');
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

describe('explicit SQL migration lifecycle on an empty database', () => {
  it('applies the complete migration chain to an empty database', async () => {
    expect(await tableNames()).toHaveLength(0);
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
    expect(result.skipped).toEqual([]);
    const tables = await tableNames();
    for (const table of ALL_TABLES) {
      expect(tables).toContain(table);
    }
    expect(tables).toContain('schema_migrations');
    // 0003 is not an IAM concern; this only proves the runner landed it.
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = 'eligibility'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
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

  it('upgrades mixed pending/enabled data without disabling MFA or deleting recovery codes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wai-iam-upgrade-safe-'));
    try {
      // Reset the shared database to the pre-migration state: the eligibility
      // schema from earlier tests must go too, or re-applying 0003 in the
      // finally would fail on its non-idempotent CREATE SCHEMA.
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      writeFileSync(
        path.join(dir, '0001_iam_account.sql'),
        readFileSync(path.join(MIGRATIONS_DIR, '0001_iam_account.sql'), 'utf8'),
      );
      const upgradeRunner = new MigrationRunner(pool, dir);
      await upgradeRunner.up();

      const accountId = '10000000-0000-4000-8000-000000000001';
      const pendingId = '20000000-0000-4000-8000-000000000001';
      const enabledId = '20000000-0000-4000-8000-000000000002';
      await pool.query(
        `INSERT INTO iam.accounts
           (id, email_digest, email_ciphertext, email_nonce, email_key_id,
            state, state_reason, state_actor_type, state_changed_at, created_at, updated_at)
         VALUES ($1, 'upgrade-digest', 'cipher', 'nonce', 'key',
                 'enabled', 'registered', 'system', now(), now(), now())`,
        [accountId],
      );
      await pool.query(
        `INSERT INTO iam.mfa_factors
           (id, account_id, type, state, secret_ciphertext, secret_nonce, secret_key_id,
            created_at, verified_at, enabled_at)
         VALUES
           ($1, $3, 'totp', 'pending', 'old-pending', 'nonce', 'key', now() - interval '1 day', NULL, NULL),
           ($2, $3, 'totp', 'enabled', 'enabled', 'nonce', 'key', now(), now(), now())`,
        [pendingId, enabledId, accountId],
      );
      await pool.query(
        `INSERT INTO iam.recovery_codes (id, factor_id, account_id, code_digest, created_at)
         VALUES ('30000000-0000-4000-8000-000000000001', $1, $2, 'upgrade-code', now())`,
        [enabledId, accountId],
      );
      await pool.query(
        `INSERT INTO iam.mfa_challenges
           (id, account_id, digest, state, attempt_count, max_attempts, expires_at, created_at)
         VALUES ('40000000-0000-4000-8000-000000000001', $1, 'legacy-challenge',
                 'pending', 0, 5, now() + interval '5 minutes', now())`,
        [accountId],
      );

      writeFileSync(
        path.join(dir, '0002_iam_r1.sql'),
        readFileSync(path.join(MIGRATIONS_DIR, '0002_iam_r1.sql'), 'utf8'),
      );
      await upgradeRunner.up();

      const factors = await pool.query<{ id: string; state: string }>(
        'SELECT id, state FROM iam.mfa_factors WHERE account_id = $1 ORDER BY id',
        [accountId],
      );
      expect(factors.rows).toEqual([{ id: enabledId, state: 'enabled' }]);
      const codes = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM iam.recovery_codes WHERE account_id = $1',
        [accountId],
      );
      expect(codes.rows[0]?.count).toBe('1');
      const legacy = await pool.query<{ state: string; device_id: string | null }>(
        `SELECT state, device_id FROM iam.mfa_challenges WHERE digest = 'legacy-challenge'`,
      );
      expect(legacy.rows).toEqual([{ state: 'expired', device_id: null }]);
      await expect(
        pool.query(
          `INSERT INTO iam.mfa_challenges
             (id, account_id, digest, state, attempt_count, max_attempts, expires_at, created_at)
           VALUES ('40000000-0000-4000-8000-000000000002', $1, 'unbound-pending',
                   'pending', 0, 5, now() + interval '5 minutes', now())`,
          [accountId],
        ),
      ).rejects.toMatchObject({ constraint: 'mfa_challenges_pending_device_chk' });
      const deviceId = '70000000-0000-4000-8000-000000000001';
      await pool.query(
        `INSERT INTO iam.devices
           (id, account_id, device_digest, label, ua_digest, ip_hmac, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'upgrade-device', 'Upgrade device', 'ua', 'ip', now(), now())`,
        [deviceId, accountId],
      );
      await expect(
        pool.query(
          `INSERT INTO iam.mfa_challenges
             (id, account_id, device_id, method_set, digest, state,
              attempt_count, max_attempts, expires_at, created_at)
           VALUES ('40000000-0000-4000-8000-000000000003', $1, $2, ARRAY[]::text[],
                   'empty-methods', 'pending', 0, 5, now() + interval '5 minutes', now())`,
          [accountId, deviceId],
        ),
      ).rejects.toMatchObject({ constraint: 'mfa_challenges_method_set_chk' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      await runner.up();
    }
  });

  it('fails closed instead of choosing arbitrarily when legacy data has multiple enabled factors', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wai-iam-upgrade-ambiguous-'));
    try {
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      writeFileSync(
        path.join(dir, '0001_iam_account.sql'),
        readFileSync(path.join(MIGRATIONS_DIR, '0001_iam_account.sql'), 'utf8'),
      );
      const upgradeRunner = new MigrationRunner(pool, dir);
      await upgradeRunner.up();
      const accountId = '50000000-0000-4000-8000-000000000001';
      await pool.query(
        `INSERT INTO iam.accounts
           (id, email_digest, email_ciphertext, email_nonce, email_key_id,
            state, state_reason, state_actor_type, state_changed_at, created_at, updated_at)
         VALUES ($1, 'ambiguous-digest', 'cipher', 'nonce', 'key',
                 'enabled', 'registered', 'system', now(), now(), now())`,
        [accountId],
      );
      await pool.query(
        `INSERT INTO iam.mfa_factors
           (id, account_id, type, state, secret_ciphertext, secret_nonce, secret_key_id,
            created_at, verified_at, enabled_at)
         VALUES
           ('60000000-0000-4000-8000-000000000001', $1, 'totp', 'enabled', 'one', 'nonce', 'key', now() - interval '1 day', now(), now()),
           ('60000000-0000-4000-8000-000000000002', $1, 'totp', 'enabled', 'two', 'nonce', 'key', now(), now(), now())`,
        [accountId],
      );
      writeFileSync(
        path.join(dir, '0002_iam_r1.sql'),
        readFileSync(path.join(MIGRATIONS_DIR, '0002_iam_r1.sql'), 'utf8'),
      );

      await expect(upgradeRunner.up()).rejects.toThrow(/multiple enabled MFA factors/i);
      const factors = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM iam.mfa_factors WHERE account_id = $1',
        [accountId],
      );
      expect(factors.rows[0]?.count).toBe('2');
      const applied = await pool.query<{ name: string }>(
        'SELECT name FROM iam.schema_migrations ORDER BY name',
      );
      expect(applied.rows.map((row) => row.name)).toEqual(['0001_iam_account.sql']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      await runner.up();
    }
  });

  it('fails loudly when an applied migration file is tampered with', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wai-iam-tamper-'));
    try {
      const original = readFileSync(path.join(MIGRATIONS_DIR, '0001_iam_account.sql'), 'utf8');
      const tampered = original.replace('CREATE SCHEMA IF NOT EXISTS iam;', '-- tampered\n');
      writeFileSync(path.join(dir, '0001_iam_account.sql'), tampered, 'utf8');
      // Reset: the main runner already applied the original file to this
      // database; a leftover tracker row would make the first apply fail.
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      const tamperRunner = new MigrationRunner(pool, dir);
      // First apply succeeds with the tampered checksum…
      await tamperRunner.up();
      // …but a second apply detects the changed checksum.
      const changed = tampered.replace('-- tampered\n', '-- tampered again\n');
      writeFileSync(path.join(dir, '0001_iam_account.sql'), changed, 'utf8');
      await expect(tamperRunner.up()).rejects.toThrow(/tampered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // Restore the pristine state the other tests assume: the tamper run
      // dropped the schema and only re-applied 0001, so the 0002/0003
      // tracker rows are gone. Re-apply all three original files from the
      // real migrations dir (eligibility dropped first — its UP is not
      // idempotent on the schema it creates).
      await pool.query('DROP SCHEMA IF EXISTS iam CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS eligibility CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS profile CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS verification CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS media CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS safety CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS connection CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS private_delivery CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS translation CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS letters CASCADE');
      await runner.up();
    }
  });

  it('rolls back 0012 through 0003 first, then 0002, then 0001: the schemas disappear', async () => {
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
    const first = await runner.down();
    expect(first).toBe('0006_profile.sql');
    const profileBase = await runner.down();
    expect(profileBase).toBe('0005_verification.sql');
    const base = await runner.down();
    expect(base).toBe('0004_eligibility_r1_hardening.sql');
    const eligibilityBase = await runner.down();
    expect(eligibilityBase).toBe('0003_eligibility.sql');
    const { rows: eligibilityRows } = await pool.query(
      `SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = 'eligibility'`,
    );
    expect(Number(eligibilityRows[0]?.n)).toBe(0);
    // The 0001 tables are still there after rolling back the later layers.
    const second = await runner.down();
    expect(second).toBe('0002_iam_r1.sql');
    const tables = await tableNames();
    for (const table of ALL_TABLES) {
      expect(tables).toContain(table);
    }
    const third = await runner.down();
    expect(third).toBe('0001_iam_account.sql');
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = 'iam'`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('re-applies forward after rollback', async () => {
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
  });
});

describe('PII never lands in plaintext', () => {
  const PEPPER = Buffer.from('p'.repeat(32), 'utf8');
  const EMAIL_DIGEST = hmacDigest(PEPPER, 'email', EMAIL);
  const TOKEN_DIGEST = hmacDigest(PEPPER, 'session', SESSION_TOKEN);
  const CODE_DIGEST = hmacDigest(PEPPER, 'recovery', RECOVERY_CODE);

  it('stores only digests/ciphertexts and every plaintext value is absent from the database', async () => {
    const accountId = '3f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c';
    const now = new Date('2026-08-15T12:00:00.000Z');

    await db.insert(schema.accounts).values({
      id: accountId,
      emailDigest: EMAIL_DIGEST,
      emailCiphertext: 'ciphertext-placeholder-nonce-tag',
      emailNonce: 'nonce-placeholder',
      emailKeyId: 'key-1',
      state: 'enabled',
      stateReason: 'registered',
      stateActorType: 'system',
      stateChangedAt: now,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.passwordCredentials).values({
      accountId,
      hash: '$argon2id$v=19$m=19456,t=2,p=1$placeholder$placeholder',
      hashVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.sessions).values({
      id: '4f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      accountId,
      familyId: '5f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      tokenDigest: TOKEN_DIGEST,
      generation: 1,
      state: 'active',
      authLevel: 'aal1',
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + 7 * 86_400_000),
      absoluteExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
    });
    await db.insert(schema.mfaFactors).values({
      id: '6f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      accountId,
      type: 'totp',
      state: 'enabled',
      secretCiphertext: 'ciphertext-secret-nonce-tag',
      secretNonce: 'nonce-placeholder',
      secretKeyId: 'key-1',
      createdAt: now,
      verifiedAt: now,
      enabledAt: now,
    });
    await db.insert(schema.recoveryCodes).values({
      id: '7f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      factorId: '6f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      accountId,
      codeDigest: CODE_DIGEST,
      createdAt: now,
    });

    const dump = await dumpAllText();
    expect(dump).not.toContain(EMAIL);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(SESSION_TOKEN);
    expect(dump).not.toContain(TOTP_SECRET);
    expect(dump).not.toContain(RECOVERY_CODE);
    // The digest itself is present (that is how lookup works)…
    expect(dump).toContain(EMAIL_DIGEST);
    expect(dump).toContain(TOKEN_DIGEST);
    expect(dump).toContain(CODE_DIGEST);
  });
});
