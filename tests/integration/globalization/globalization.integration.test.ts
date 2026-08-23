import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createPool,
  GlobalizationAccountUnavailableError,
  GlobalizationIdempotencyConflictError,
  GlobalizationTimeZoneError,
  GlobalizationVersionConflictError,
  MigrationRunner,
  PgGlobalizationRepository,
} from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

declare const WAI_MIGRATIONS_DIR: string;
const ACCOUNT_A = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_B = '10000000-0000-4000-8000-000000000002';
const ACCOUNT_C = '10000000-0000-4000-8000-000000000003';
const value = {
  ui_locale: 'fr' as const,
  content_locales: ['fr', 'en'],
  time_zone: 'Europe/Paris',
  hour_cycle: 'h24' as const,
  week_start: 0,
};
let started: StartedInfra;
let pool: Pool;
let repo: PgGlobalizationRepository;
let runner: MigrationRunner;

async function account(id: string, state = 'enabled') {
  await pool.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at) VALUES($1,$2,'cipher','nonce','test-key',$3,$4,'system',now(),0,now(),now())`,
    [id, `${id}-digest`, state, state === 'enabled' ? 'registered' : 'admin_suspend'],
  );
}

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  // Keep the module lifecycle proof scoped to GLO-01. Later migrations are
  // validated by their own tests and by the integrated migration suite.
  runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, {
    through: '0015_globalization.sql',
  });
  await runner.up();
  repo = new PgGlobalizationRepository(pool);
});
afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('GLO-01 real PostgreSQL lifecycle and authority', () => {
  it('runs fresh, no-op, down/up and validates timezone authority', async () => {
    const noOp = await runner.up();
    expect(noOp.applied).toEqual([]);
    expect(noOp.skipped).toContain('0015_globalization.sql');
    expect(await runner.down()).toBe('0015_globalization.sql');
    expect(
      (await pool.query(`SELECT to_regclass('globalization.account_preferences') AS table_name`))
        .rows[0]?.table_name,
    ).toBeNull();
    expect((await runner.up()).applied).toEqual(['0015_globalization.sql']);
    await account(ACCOUNT_A);
    const initial = await repo.read(ACCOUNT_A);
    expect(initial?.version).toBe(0);
    await expect(
      repo.replace({
        accountId: ACCOUNT_A,
        expectedVersion: 9,
        idempotencyKey: 'stale-first',
        requestDigest: 'a'.repeat(64),
        value,
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(GlobalizationVersionConflictError);
    const written = await repo.replace({
      accountId: ACCOUNT_A,
      expectedVersion: 0,
      idempotencyKey: 'first-write',
      requestDigest: 'b'.repeat(64),
      value,
      now: new Date(),
    });
    expect(written.value.version).toBe(1);
    await expect(
      repo.replace({
        accountId: ACCOUNT_A,
        expectedVersion: 1,
        idempotencyKey: 'bad-time-zone',
        requestDigest: 'c'.repeat(64),
        value: { ...value, time_zone: 'Mars/Nope' },
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(GlobalizationTimeZoneError);
    expect((await repo.read(ACCOUNT_A))?.time_zone).toBe('Europe/Paris');
  });
  it('enforces disabled account, replay/conflict and concurrent first-write races', async () => {
    await account(ACCOUNT_B);
    const now = new Date();
    const request = {
      accountId: ACCOUNT_B,
      expectedVersion: 0,
      requestDigest: 'd'.repeat(64),
      value,
      now,
    };
    const same = await Promise.all([
      repo.replace({ ...request, idempotencyKey: 'same-key' }),
      repo.replace({ ...request, idempotencyKey: 'same-key' }),
    ]);
    expect(same.map((item) => item.value.version)).toEqual([1, 1]);
    expect(same.filter((item) => item.replayed)).toHaveLength(1);
    expect(same.filter((item) => !item.replayed)).toHaveLength(1);
    await expect(
      repo.replace({ ...request, idempotencyKey: 'same-key', requestDigest: 'e'.repeat(64) }),
    ).rejects.toBeInstanceOf(GlobalizationIdempotencyConflictError);
    await account(ACCOUNT_C);
    const freshRequest = { ...request, accountId: ACCOUNT_C };
    const results = await Promise.allSettled([
      repo.replace({ ...freshRequest, idempotencyKey: 'race-a', requestDigest: 'f'.repeat(64) }),
      repo.replace({ ...freshRequest, idempotencyKey: 'race-b', requestDigest: '0'.repeat(64) }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'GLOBALIZATION_VERSION_CONFLICT' });
    await pool.query(
      `UPDATE iam.accounts SET state='suspended', state_reason='admin_suspend' WHERE id=$1`,
      [ACCOUNT_B],
    );
    await expect(
      repo.replace({ ...request, idempotencyKey: 'disabled', requestDigest: 'h'.repeat(64) }),
    ).rejects.toBeInstanceOf(GlobalizationAccountUnavailableError);
    expect(await repo.read(ACCOUNT_B)).toBeNull();
  });
  it('keeps preference audit hash-only and append-only', async () => {
    const second = await repo.replace({
      accountId: ACCOUNT_A,
      expectedVersion: 1,
      idempotencyKey: 'audit-second-write',
      requestDigest: '9'.repeat(64),
      value: { ...value, content_locales: ['fr'], time_zone: 'Asia/Shanghai' },
      now: new Date(),
    });
    expect(second.value.version).toBe(2);
    const rows = await pool.query<{
      content_locales_old_hash: string | null;
      content_locales_new_hash: string;
      time_zone_old_hash: string | null;
      time_zone_new_hash: string;
    }>(
      'SELECT content_locales_old_hash,content_locales_new_hash,time_zone_old_hash,time_zone_new_hash FROM globalization.preference_audit WHERE account_id=$1 ORDER BY version',
      [ACCOUNT_A],
    );
    expect(rows.rows).toHaveLength(2);
    const hash = (input: unknown) =>
      createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(rows.rows[0]?.content_locales_new_hash).toBe(hash(value.content_locales));
    expect(rows.rows[0]?.content_locales_old_hash).toBeNull();
    expect(rows.rows[0]?.time_zone_new_hash).toBe(hash(value.time_zone));
    expect(rows.rows[0]?.time_zone_old_hash).toBeNull();
    expect(rows.rows[1]?.content_locales_old_hash).toBe(hash(value.content_locales));
    expect(rows.rows[1]?.content_locales_new_hash).toBe(hash(['fr']));
    expect(rows.rows[1]?.time_zone_old_hash).toBe(hash(value.time_zone));
    expect(rows.rows[1]?.time_zone_new_hash).toBe(hash('Asia/Shanghai'));
    const auditColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='globalization' AND table_name='preference_audit'
         AND column_name IN ('content_locales_old','content_locales_new','time_zone_old','time_zone_new')`,
    );
    expect(auditColumns.rows).toEqual([]);
    const rawValues = await pool.query<{ row_json: string }>(
      `SELECT row_to_json(a)::text AS row_json
       FROM globalization.preference_audit a WHERE account_id=$1`,
      [ACCOUNT_A],
    );
    expect(
      rawValues.rows.every(
        ({ row_json }) =>
          !row_json.includes('Europe/Paris') &&
          !row_json.includes('Asia/Shanghai') &&
          !row_json.includes('["fr","en"]') &&
          !row_json.includes('["fr"]'),
      ),
    ).toBe(true);
    await expect(
      pool.query(
        `UPDATE globalization.preference_audit SET time_zone_new_hash='${'0'.repeat(64)}' WHERE account_id=$1`,
        [ACCOUNT_A],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM globalization.preference_audit WHERE account_id=$1`, [ACCOUNT_A]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM iam.accounts WHERE id=$1', [ACCOUNT_A]),
    ).resolves.toBeDefined();
    await pool.query('DELETE FROM iam.accounts WHERE id = ANY($1::uuid[])', [
      [ACCOUNT_B, ACCOUNT_C],
    ]);
    for (const table of [
      'globalization.account_preferences',
      'globalization.preference_idempotency',
      'globalization.preference_audit',
    ]) {
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(count.rows[0]?.count, table).toBe('0');
    }
  });
});
