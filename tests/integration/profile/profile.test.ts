import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadEnv } from '@wai/config';
import {
  canonicalJsonHash,
  createDb,
  createPool,
  MigrationRunner,
  parsePiiKeys,
  PgProfileRepository,
} from '@wai/db';
import type { ProfileMutationResult } from '@wai/contracts';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

declare const WAI_MIGRATIONS_DIR: string;
const ACCOUNT = 'faaaaaaa-0000-4000-8000-000000000001';
const FRESH_ACCOUNT = 'faaaaaaa-0000-4000-8000-000000000002';
let infra: StartedInfra;
let pool: Pool;
let repo: PgProfileRepository;

beforeAll(async () => {
  infra = await startTestInfra();
  pool = createPool(infra.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  const config = loadEnv({ NODE_ENV: 'test', DATABASE_URL: infra.infra.databaseUrl });
  repo = new PgProfileRepository(
    createDb(pool),
    parsePiiKeys(config.iam.piiKeysJson),
    config.iam.piiKeyId,
  );
  await pool.query(
    `INSERT INTO iam.accounts (id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,'profile-test','cipher','nonce','key','enabled','registered','system',now(),now(),now())`,
    [ACCOUNT],
  );
  await pool.query(
    `INSERT INTO iam.accounts (id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,'profile-test-fresh','cipher','nonce','key','enabled','registered','system',now(),now(),now())`,
    [FRESH_ACCOUNT],
  );
});
afterAll(async () => {
  await pool?.end();
  await infra?.stop();
});

describe('PRF-01 PostgreSQL privacy and concurrency', () => {
  it('stores sensitive and AI-only facts encrypted and snapshots only low facts', async () => {
    const initial = await repo.getOrCreate(ACCOUNT);
    const withSensitive = await repo.putFact({
      accountId: ACCOUNT,
      factKey: 'availability',
      value: 'weekends',
      source: 'user_confirmed',
      expectedVersion: initial.version,
      idempotencyKey: 'profile-fact-sensitive-1',
      payloadDigest: 'a'.repeat(64),
    });
    const withAi = await repo.putFact({
      accountId: ACCOUNT,
      factKey: 'ai_profile_summary',
      value: 'private',
      source: 'approved_draft',
      expectedVersion: withSensitive.version,
      idempotencyKey: 'profile-fact-ai-only-1',
      payloadDigest: 'b'.repeat(64),
    });
    await repo.putFact({
      accountId: ACCOUNT,
      factKey: 'about_me',
      value: 'hello',
      source: 'user_confirmed',
      expectedVersion: withAi.version,
      idempotencyKey: 'profile-fact-low-plain-1',
      payloadDigest: 'c'.repeat(64),
    });
    const rows = await pool.query<{ value_json: unknown; value_ciphertext: string | null }>(
      'SELECT value_json,value_ciphertext FROM profile.profile_facts ORDER BY fact_key',
    );
    expect(rows.rows.find((r) => r.value_ciphertext !== null)?.value_json).toBeNull();
    expect(JSON.stringify(rows.rows)).not.toContain('weekends');
    const published = await repo.publish(
      ACCOUNT,
      (await repo.getOrCreate(ACCOUNT)).version,
      'profile-publish-1',
    );
    expect(published.profile.facts.filter((f) => f.sensitivity !== 'low')).toHaveLength(2);
    const snapshot = await pool.query<{ payload: string }>(
      'SELECT payload::text FROM profile.snapshots WHERE id=$1',
      [published.snapshotId],
    );
    expect(snapshot.rows[0]?.payload).not.toContain('weekends');
    expect(snapshot.rows[0]?.payload).not.toContain('private');
  });

  it('optimistic concurrency prevents lost updates and audit is append-only', async () => {
    const profile = await repo.getOrCreate(ACCOUNT);
    const results = await Promise.allSettled([
      repo.updateProfile({
        accountId: ACCOUNT,
        expectedVersion: profile.version,
        idempotencyKey: 'profile-concurrent-a',
        payloadDigest: 'd'.repeat(64),
        displayName: 'A',
      }),
      repo.updateProfile({
        accountId: ACCOUNT,
        expectedVersion: profile.version,
        idempotencyKey: 'profile-concurrent-b',
        payloadDigest: 'e'.repeat(64),
        displayName: 'B',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await repo.appendSensitiveAudit({
      actorAccountId: ACCOUNT,
      subjectAccountId: ACCOUNT,
      factKey: 'availability',
      purpose: 'integration',
      decision: 'allow',
      policyVersion: 'prf-1',
    });
    await expect(pool.query(`DELETE FROM profile.sensitive_access_audit`)).rejects.toThrow();
  });

  it('database rejects mixed or policy-incompatible fact representations', async () => {
    const profile = await pool.query<{ id: string }>(
      'SELECT id FROM profile.profiles WHERE account_id=$1',
      [ACCOUNT],
    );
    const profileId = profile.rows[0]?.id;
    await expect(
      pool.query(
        `INSERT INTO profile.profile_facts (id,profile_id,fact_key,state,source,value_json,value_ciphertext,value_nonce,value_key_id,confirmed_at,version) VALUES ('faaaaaaa-1000-4000-8000-000000000001',$1,'availability','confirmed','user_confirmed','"plain"','cipher','nonce','key',now(),0)`,
        [profileId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO profile.profile_facts (id,profile_id,fact_key,state,source,value_json,value_ciphertext,value_nonce,value_key_id,confirmed_at,version) VALUES ('faaaaaaa-1000-4000-8000-000000000002',$1,'about_me','confirmed','user_confirmed',NULL,'cipher','nonce','key',now(),0)`,
        [profileId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO profile.fact_definitions (fact_key,value_kind,sensitivity,allowed_modes,default_audience,ai_only,policy_version) VALUES ('bad_modes','text','low',ARRAY['dating','unknown'],'nobody',false,'prf-1')`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO profile.fact_uses (profile_id,fact_key,mode,matching_enabled,updated_at) VALUES ($1,'availability','dating',true,now())`,
        [profileId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO profile.fact_audiences (profile_id,fact_key,mode,audience,age_partition,updated_at) VALUES ($1,'availability','dating','connections','adult',now())`,
        [profileId],
      ),
    ).rejects.toThrow();
  });

  it('freezes idempotent mutation and publish results, and rejects missing withdrawal', async () => {
    const before = await repo.getOrCreate(ACCOUNT);
    const first = await repo.updateProfile({
      accountId: ACCOUNT,
      expectedVersion: before.version,
      idempotencyKey: 'profile-frozen-update-1',
      payloadDigest: 'f'.repeat(64),
      displayName: 'Frozen',
    });
    const second = await repo.updateProfile({
      accountId: ACCOUNT,
      expectedVersion: first.version,
      idempotencyKey: 'profile-frozen-update-2',
      payloadDigest: '7'.repeat(64),
      displayName: 'Later',
    });
    const replay = await repo.updateProfile({
      accountId: ACCOUNT,
      expectedVersion: before.version,
      idempotencyKey: 'profile-frozen-update-1',
      payloadDigest: 'f'.repeat(64),
      displayName: 'Frozen',
    });
    expect(replay.version).toBe(first.version);
    const pub1 = await repo.publish(ACCOUNT, second.version, 'profile-frozen-publish-1');
    const pub2 = await repo.publish(ACCOUNT, second.version, 'profile-frozen-publish-2');
    expect(pub2.snapshotId).toBe(pub1.snapshotId);
    const updated = await repo.updateProfile({
      accountId: ACCOUNT,
      expectedVersion: pub1.profile.version,
      idempotencyKey: 'profile-after-publish-update',
      payloadDigest: '9'.repeat(64),
      displayName: 'Changed after publish',
    });
    const publishReplay = await repo.publish(
      ACCOUNT,
      pub1.profile.version,
      'profile-frozen-publish-1',
    );
    expect(publishReplay.profile.version).toBe(pub1.profile.version);
    expect(updated.version).toBe(pub1.profile.version + 1);
    const idempotency = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile.idempotency_keys WHERE account_id=$1 AND idempotency_key_digest IN ($2,$3)`,
      [
        ACCOUNT,
        canonicalJsonHash('profile-frozen-publish-1'),
        canonicalJsonHash('profile-frozen-publish-2'),
      ],
    );
    expect(idempotency.rows[0]?.n).toBe('2');
    const rawColumn = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile.idempotency_keys WHERE account_id=$1 AND idempotency_key_digest=$2`,
      [ACCOUNT, 'profile-frozen-publish-1'],
    );
    expect(rawColumn.rows[0]?.n).toBe('0');
    const rawKey = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile.idempotency_keys WHERE account_id=$1 AND result_json::text LIKE $2`,
      [ACCOUNT, '%profile-frozen-publish-1%'],
    );
    expect(rawKey.rows[0]?.n).toBe('0');
    await expect(
      repo.withdrawFact({
        accountId: ACCOUNT,
        factKey: 'does_not_exist',
        expectedVersion: (await repo.getOrCreate(ACCOUNT)).version,
        idempotencyKey: 'profile-withdraw-missing',
        payloadDigest: 'a'.repeat(64),
      }),
    ).rejects.toThrow('fact_not_found');
    const snapshot = await repo.getSnapshot(ACCOUNT, pub1.snapshotId);
    expect(snapshot?.display_name).not.toBe('Changed after publish');
    expect(snapshot?.facts[0]?.confirmed_at).toBeDefined();
  });

  it('creates a profile atomically on the first real PostgreSQL write', async () => {
    const writes = await Promise.allSettled([
      repo.updateProfile({
        accountId: FRESH_ACCOUNT,
        expectedVersion: 0,
        idempotencyKey: 'profile-first-write-a',
        payloadDigest: '1'.repeat(64),
        displayName: 'First',
      }),
      repo.updateProfile({
        accountId: FRESH_ACCOUNT,
        expectedVersion: 0,
        idempotencyKey: 'profile-first-write-b',
        payloadDigest: '2'.repeat(64),
        displayName: 'Second',
      }),
    ]);
    expect(writes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const row = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM profile.profiles WHERE account_id=$1',
      [FRESH_ACCOUNT],
    );
    expect(row.rows[0]?.n).toBe('1');
  });

  it('serializes identical concurrent mutation and publish idempotency keys', async () => {
    const before = await repo.getOrCreate(ACCOUNT);
    const mutationResults = await Promise.allSettled([
      repo.updateProfile({
        accountId: ACCOUNT,
        expectedVersion: before.version,
        idempotencyKey: 'profile-concurrent-same-key',
        payloadDigest: 'b'.repeat(64),
        displayName: 'Same request',
      }),
      repo.updateProfile({
        accountId: ACCOUNT,
        expectedVersion: before.version,
        idempotencyKey: 'profile-concurrent-same-key',
        payloadDigest: 'b'.repeat(64),
        displayName: 'Same request',
      }),
    ]);
    expect(mutationResults.every((r) => r.status === 'fulfilled')).toBe(true);
    const mutationValues = mutationResults
      .filter((r): r is PromiseFulfilledResult<ProfileMutationResult> => r.status === 'fulfilled')
      .map((r) => r.value.version);
    expect(mutationValues).toEqual([before.version + 1, before.version + 1]);
    await expect(
      repo.updateProfile({
        accountId: ACCOUNT,
        expectedVersion: before.version,
        idempotencyKey: 'profile-concurrent-same-key',
        payloadDigest: 'c'.repeat(64),
        displayName: 'Different request',
      }),
    ).rejects.toThrow('idempotency key payload conflict');

    const current = await repo.getOrCreate(ACCOUNT);
    const publishResults = await Promise.allSettled([
      repo.publish(ACCOUNT, current.version, 'profile-concurrent-publish-key'),
      repo.publish(ACCOUNT, current.version, 'profile-concurrent-publish-key'),
    ]);
    expect(publishResults.every((r) => r.status === 'fulfilled')).toBe(true);
    const publishValues = publishResults
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<PgProfileRepository['publish']>>> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value.snapshotId);
    expect(publishValues[0]).toBe(publishValues[1]);
  });
});
