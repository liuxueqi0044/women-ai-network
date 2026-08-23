import { createHash } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner, PgMediaRepository, createPool } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { MemoryMediaStorage } from '../../../apps/api/src/media/media.adapters.js';
import {
  MediaAccessTokenService,
  MediaService,
} from '../../../apps/api/src/media/media.service.js';
import type {
  QueueEnqueueOptions,
  QueueProducerAdapter,
} from '../../../apps/api/src/infra/adapters.js';
import { DurableMediaJobRunner } from '../../../apps/worker/src/media/pipeline.js';
import { processMediaWakeup } from '../../../apps/worker/src/worker.module.js';
import { waitFor } from '../helpers.js';

declare const WAI_MIGRATIONS_DIR: string;

const owner = '11111111-1111-4111-8111-111111111111';
const assetId = '33333333-3333-4333-8333-333333333333';

let started: StartedInfra;
let pool: ReturnType<typeof createPool>;
let queue: Queue;
let worker: Worker;

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
});

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await pool?.end();
  await started?.stop();
});

describe('MED-01 real BullMQ replay wake-up', () => {
  it('replays after an exhausted failed wake and continues the real PG durable job', async () => {
    const connection = {
      host: started.infra.valkey.host,
      port: started.infra.valkey.port,
      password: started.infra.valkey.password,
      maxRetriesPerRequest: null,
    };
    const queueName = `media-r1-${Date.now()}`;
    queue = new Queue(queueName, { connection });
    const repository = new PgMediaRepository(pool);
    let calls = 0;
    const runner = new DurableMediaJobRunner(repository, {
      process: async (job: { jobId: string; leaseToken: string; assetId: string }) => {
        calls += 1;
        if (calls === 1) throw new Error('forced wake failure');
        await repository.advanceStage({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          assetId: job.assetId,
          to: 'scanning',
        });
        await repository.advanceStage({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          assetId: job.assetId,
          to: 'sanitizing',
        });
        const finished = await repository.finishJob({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          state: 'clean',
        });
        return finished ? 'clean' : 'retryable';
      },
    } as never);
    worker = new Worker(
      queueName,
      async (job) => processMediaWakeup(runner, 'queue-worker', { name: job.name, data: job.data }),
      { connection, autorun: true },
    );
    const queueAdapter: QueueProducerAdapter = {
      async enqueue(name: string, data: unknown, options: QueueEnqueueOptions) {
        await queue.add(name, data, {
          jobId: options.jobId,
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        });
      },
      async check() {
        await queue.getJobCounts();
        return true;
      },
      async close() {},
    };
    await pool.query(
      `INSERT INTO iam.accounts (id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES ($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')`,
      [owner, owner.replaceAll('-', '')],
    );
    const intentId = '22222222-2222-4222-8222-222222222222';
    const idempotencyDigest = createHash('sha256')
      .update(`${owner}:idempotency:r1-key-123`)
      .digest('hex');
    await pool.query(
      `INSERT INTO media.assets (id,owner_id,purpose,state,declared_size,declared_content_type,version,retention_state,created_at,updated_at) VALUES ($1,$2,'profile_avatar','reserved',100,'image/jpeg',1,'active',now(),now())`,
      [assetId, owner],
    );
    await pool.query(
      `INSERT INTO media.upload_intents (id,asset_id,owner_id,idempotency_digest,quarantine_key_digest,payload_digest,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now())`,
      [intentId, assetId, owner, idempotencyDigest, 'a'.repeat(64), 'b'.repeat(64)],
    );
    const bytes = new Uint8Array(100);
    bytes.set([0xff, 0xd8, 0xff], 0);
    bytes.set([0xff, 0xd9], bytes.length - 2);
    const storage = new MemoryMediaStorage();
    storage.seed(`quarantine/${assetId}`, bytes);
    const service = new MediaService(
      repository,
      storage,
      { canRead: async () => true, canDelete: async () => true },
      new MediaAccessTokenService(new Uint8Array(32).fill(2)),
      (id) => `quarantine/${id}`,
      (value) => createHash('sha256').update(value).digest('hex'),
      (id) => `clean/${id}`,
      queueAdapter,
    );
    await service.completeIntent({ ownerId: owner, assetId, idempotencyKey: 'r1-key-123' });
    await waitFor('first wake exhausted and retained', async () => {
      const count = (await queue.getJobCounts())['failed'];
      return count === 1 ? count : null;
    });
    expect(calls).toBe(1);
    expect((await repository.asset(assetId))?.state).toBe('retryable');
    await service.completeIntent({ ownerId: owner, assetId, idempotencyKey: 'r1-key-123' });
    await waitFor('replayed wake consumed', async () => {
      const count = (await queue.getJobCounts())['completed'];
      return count === 1 ? count : null;
    });
    expect(calls).toBe(2);
    expect((await queue.getJobCounts())['failed']).toBe(1);
    expect((await repository.asset(assetId))?.state).toBe('clean');

    const concurrentAsset = '66666666-6666-4666-8666-666666666666';
    const concurrentJob = '77777777-7777-4777-8777-777777777777';
    const concurrentIntent = '88888888-8888-4888-8888-888888888888';
    await pool.query(
      `INSERT INTO media.assets (id,owner_id,purpose,state,declared_size,version,retention_state,created_at,updated_at) VALUES ($1,$2,'profile_avatar','uploaded',100,1,'active',now(),now())`,
      [concurrentAsset, owner],
    );
    await pool.query(
      `INSERT INTO media.upload_intents (id,asset_id,owner_id,idempotency_digest,quarantine_key_digest,payload_digest,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now())`,
      [concurrentIntent, concurrentAsset, owner, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO media.processing_jobs (id,asset_id,stage,status,created_at,updated_at) VALUES ($1,$2,'scan','queued',now(),now())`,
      [concurrentJob, concurrentAsset],
    );
    const concurrent = await Promise.all([
      runner.runOnce('concurrent-a'),
      runner.runOnce('concurrent-b'),
    ]);
    expect(concurrent.filter((result) => result === 'clean')).toHaveLength(1);
    expect(concurrent.filter((result) => result === 'idle')).toHaveLength(1);
  }, 30_000);
});
