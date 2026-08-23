import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner, PgMediaRepository, createPool } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

declare const WAI_MIGRATIONS_DIR: string;

let started: StartedInfra;
let pool: Pool;
let runner: MigrationRunner;

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR);
  await runner.up();
});

afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('MED-01 PostgreSQL lifecycle and lease concurrency', () => {
  it('rejects an uploaded-to-clean state jump in the database', async () => {
    const accountId = '10000000-0000-4000-8000-000000000001';
    const assetId = '20000000-0000-4000-8000-000000000001';
    await pool.query(
      `INSERT INTO iam.accounts (id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES ($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')`,
      [accountId, accountId.replaceAll('-', '')],
    );
    await pool.query(
      `INSERT INTO media.assets (id,owner_id,purpose,state,declared_size,version,retention_state,created_at,updated_at) VALUES ($1,$2,'profile_avatar','uploaded',12,1,'active',now(),now())`,
      [assetId, accountId],
    );
    await expect(
      pool.query(`UPDATE media.assets SET state='clean' WHERE id=$1`, [assetId]),
    ).rejects.toThrow(/invalid media state transition/);
  });

  it('allows only one claimant and prevents stale completion after reclaim', async () => {
    const accountId = '10000000-0000-4000-8000-000000000002';
    const assetId = '20000000-0000-4000-8000-000000000002';
    const intentId = '30000000-0000-4000-8000-000000000002';
    const jobId = '40000000-0000-4000-8000-000000000002';
    await pool.query(
      `INSERT INTO iam.accounts (id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES ($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')`,
      [accountId, accountId.replaceAll('-', '')],
    );
    await pool.query(
      `INSERT INTO media.assets (id,owner_id,purpose,state,declared_size,version,retention_state,created_at,updated_at) VALUES ($1,$2,'profile_avatar','uploaded',12,1,'active',now(),now())`,
      [assetId, accountId],
    );
    await pool.query(
      `INSERT INTO media.upload_intents (id,asset_id,owner_id,idempotency_digest,quarantine_key_digest,payload_digest,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now())`,
      [intentId, assetId, accountId, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO media.processing_jobs (id,asset_id,stage,status,created_at,updated_at) VALUES ($1,$2,'scan','queued',now(),now())`,
      [jobId, assetId],
    );
    const repo = new PgMediaRepository(pool);
    const now = new Date();
    const [first, second] = await Promise.all([
      repo.claimJob({ workerId: 'one', now, leaseSeconds: 60 }),
      repo.claimJob({ workerId: 'two', now, leaseSeconds: 60 }),
    ]);
    expect([first, second].filter((value) => value !== null)).toHaveLength(1);
    const claimed = first ?? second;
    expect(claimed).not.toBeNull();
    const reclaimed = await repo.claimJob({
      workerId: 'three',
      now: new Date(now.getTime() + 61_000),
      leaseSeconds: 60,
    });
    expect(reclaimed).not.toBeNull();
    expect(
      await repo.finishJob({
        jobId,
        leaseToken: claimed!.leaseToken,
        state: 'rejected',
        errorCode: 'OBJECT_MISMATCH',
        now,
      }),
    ).toBe(false);
    expect(
      await repo.finishJob({
        jobId,
        leaseToken: reclaimed!.leaseToken,
        state: 'rejected',
        errorCode: 'OBJECT_MISMATCH',
        now: new Date(now.getTime() + 61_000),
      }),
    ).toBe(true);
  });

  it('allows explicit delete/hold from every non-terminal lifecycle state', async () => {
    const accountId = '10000000-0000-4000-8000-000000000003';
    await pool.query(
      `INSERT INTO iam.accounts (id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES ($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')`,
      [accountId, accountId.replaceAll('-', '')],
    );
    const states = [
      'reserved',
      'uploaded',
      'scanning',
      'sanitizing',
      'clean',
      'rejected',
      'retryable',
    ];
    for (const [index, state] of states.entries()) {
      const assetId = `20000000-0000-4000-8000-00000000010${index}`;
      await pool.query(
        `INSERT INTO media.assets (id,owner_id,purpose,state,declared_size,version,retention_state,created_at,updated_at) VALUES ($1,$2,'profile_avatar',$3,12,1,'active',now(),now())`,
        [assetId, accountId, state],
      );
      await expect(
        pool.query(
          `UPDATE media.assets SET state='held',retention_state='held',legal_hold_at=now() WHERE id=$1`,
          [assetId],
        ),
      ).resolves.toBeTruthy();
    }
    const heldAsset = '20000000-0000-4000-8000-000000000120';
    await pool.query(
      `INSERT INTO media.assets (id,owner_id,purpose,state,declared_size,version,retention_state,created_at,updated_at) VALUES ($1,$2,'profile_avatar','uploaded',12,1,'active',now(),now())`,
      [heldAsset, accountId],
    );
    const repo = new PgMediaRepository(pool);
    expect(await repo.placeLegalHold(heldAsset)).toBe(true);
    expect(await repo.markDeleted(heldAsset, accountId)).toBe('held');
  });

  it('can resume a retryable job through the durable stage transition', async () => {
    const accountId = '10000000-0000-4000-8000-000000000004';
    const assetId = '20000000-0000-4000-8000-000000000130';
    const jobId = '40000000-0000-4000-8000-000000000130';
    const intentId = '30000000-0000-4000-8000-000000000130';
    await pool.query(
      `INSERT INTO iam.accounts (id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES ($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')`,
      [accountId, accountId.replaceAll('-', '')],
    );
    await pool.query(
      `INSERT INTO media.assets (id,owner_id,purpose,state,declared_size,version,retention_state,created_at,updated_at) VALUES ($1,$2,'profile_avatar','retryable',12,1,'active',now(),now())`,
      [assetId, accountId],
    );
    await pool.query(
      `INSERT INTO media.upload_intents (id,asset_id,owner_id,idempotency_digest,quarantine_key_digest,payload_digest,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now())`,
      [intentId, assetId, accountId, '4'.repeat(64), '5'.repeat(64), '6'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO media.processing_jobs (id,asset_id,stage,status,next_retry_at,created_at,updated_at) VALUES ($1,$2,'scan','retryable',now()-interval '1 second',now(),now())`,
      [jobId, assetId],
    );
    const repo = new PgMediaRepository(pool);
    const claimed = await repo.claimJob({
      workerId: 'retry-worker',
      now: new Date(),
      leaseSeconds: 60,
    });
    expect(claimed?.jobId).toBe(jobId);
    expect(
      await repo.advanceStage({
        jobId,
        leaseToken: claimed!.leaseToken,
        assetId,
        to: 'scanning',
      }),
    ).toBe(true);
    expect((await repo.asset(assetId))?.state).toBe('scanning');
  });
});
