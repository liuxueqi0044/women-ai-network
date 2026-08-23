import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner, PgPrivateDeliveryRepository, createPool, parsePepper } from '@wai/db';
import type { InteractionGatePort } from '@wai/contracts';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { DurablePrivateDeliveryRunner } from '../../../apps/worker/src/private-delivery/runner.js';
import { waitFor } from '../helpers.js';

declare const WAI_MIGRATIONS_DIR: string;
const sender = '20000000-0000-4000-8000-000000000001';
const recipient = '20000000-0000-4000-8000-000000000002';
const connectionId = '20000000-0000-4000-8000-000000000010';
const letterId = '20000000-0000-4000-8000-000000000020';
const revisionId = '20000000-0000-4000-8000-000000000021';
const letterIdTwo = '20000000-0000-4000-8000-000000000022';
const revisionIdTwo = '20000000-0000-4000-8000-000000000023';
const sourceHash = 'c'.repeat(64);
let infra: StartedInfra;
let pool: ReturnType<typeof createPool>;
let queue: Queue;
let worker: Worker;

beforeAll(async () => {
  infra = await startTestInfra();
  pool = createPool(infra.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  const now = new Date();
  for (const [id, digest] of [
    [sender, 'sender'],
    [recipient, 'recipient'],
  ] as const)
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,$2,'c','n','k','enabled','registered','system',$3,$3,$3)`,
      [id, digest, now],
    );
  await pool.query(
    `INSERT INTO connection.connections(id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at) VALUES ($1,$2,$3,$2,$3,'friends','accepted',1,$4,$4,$4)`,
    [connectionId, sender, recipient, now],
  );
  await pool.query('BEGIN');
  await pool.query(
    `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at) VALUES ($1,$2,'private_letter','draft',1,1,$3,$3)`,
    [letterId, sender, now],
  );
  await pool.query(
    `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at) VALUES ($1,$2,1,$3,'c','n','c','n','c','n','k',$4)`,
    [revisionId, letterId, sourceHash, now],
  );
  await pool.query(
    `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at) VALUES ($1,$2,'private_letter','draft',1,1,$3,$3)`,
    [letterIdTwo, sender, now],
  );
  await pool.query(
    `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at) VALUES ($1,$2,1,$3,'c','n','c','n','c','n','k',$4)`,
    [revisionIdTwo, letterIdTwo, 'd'.repeat(64), now],
  );
  await pool.query('COMMIT');
}, 180_000);
afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await pool?.end();
  await infra?.stop();
}, 180_000);

describe('PVL real BullMQ to PostgreSQL worker', () => {
  it('consumes an opaque wake, claims durable PG once, and emits one notification', async () => {
    const repo = new PgPrivateDeliveryRepository(pool, {
      keyId: 'active',
      key: Buffer.alloc(32, 9),
      hmacKey: parsePepper('q'.repeat(32)),
    });
    const delivery = await repo.createQueued({
      senderAccountId: sender,
      recipientAccountId: recipient,
      connectionId,
      connectionEpoch: 1,
      mode: 'friends',
      purpose: 'private_letter_delivery',
      snapshot: {
        letterId,
        revisionId,
        revision: 1,
        sourceHash,
        content: {
          title: 'Queue title',
          body: { paragraphs: ['Queue body'] },
          locale: 'en-US',
          country_code: 'US',
          topics: ['friendship'],
          content_reminder: 'none',
          pen_name: 'Queue pen',
        },
      },
      idempotencyKey: 'queue-idempotency-key',
    });
    const gate: InteractionGatePort = { check: async () => ({ allowed: true }) };
    const runner = new DurablePrivateDeliveryRunner(repo, gate);
    const connection = {
      host: infra.infra.valkey.host,
      port: infra.infra.valkey.port,
      password: infra.infra.valkey.password,
      maxRetriesPerRequest: null,
    };
    queue = new Queue(`pvl-${Date.now()}`, { connection });
    worker = new Worker(
      queue.name,
      async (job) => runner.process('queue-worker', { name: job.name, data: job.data }),
      { connection, concurrency: 2 },
    );
    await queue.add(
      'private-delivery.wakeup',
      { delivery_id: delivery.deliveryId },
      { jobId: `pvl:${delivery.deliveryId}`, removeOnComplete: false },
    );
    await waitFor('private delivery completed', async () => {
      const row = (
        await pool.query(`SELECT state FROM private_delivery.deliveries WHERE id=$1`, [
          delivery.deliveryId,
        ])
      ).rows[0] as { state: string } | undefined;
      return row?.state === 'delivered' ? row.state : null;
    });
    const duplicate = await Promise.all([
      runner.process('direct-a', {
        name: 'private-delivery.wakeup',
        data: { delivery_id: delivery.deliveryId },
      }),
      runner.process('direct-b', {
        name: 'private-delivery.wakeup',
        data: { delivery_id: delivery.deliveryId },
      }),
    ]);
    expect(duplicate.every((value) => value === 'idle')).toBe(true);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM private_delivery.notification_outbox WHERE delivery_id=$1`,
          [delivery.deliveryId],
        )
      ).rows[0].count,
    ).toBe(1);

    const second = await repo.createQueued({
      senderAccountId: sender,
      recipientAccountId: recipient,
      connectionId,
      connectionEpoch: 1,
      mode: 'friends',
      purpose: 'private_letter_delivery',
      snapshot: {
        letterId: letterIdTwo,
        revisionId: revisionIdTwo,
        revision: 1,
        sourceHash: 'd'.repeat(64),
        content: {
          title: 'Queue title two',
          body: { paragraphs: ['Queue body two'] },
          locale: 'en-US',
          country_code: 'US',
          topics: ['friendship'],
          content_reminder: 'none',
          pen_name: 'Queue pen',
        },
      },
      idempotencyKey: 'queue-idempotency-key-two',
    });
    // Simulate a retained/exhausted BullMQ wake. Replay recovery resets only
    // the PG intent; the next opaque wake still claims the exact delivery.
    await pool.query(
      `UPDATE private_delivery.wake_intents SET state='failed',attempts=max_attempts,last_error_code='WAKE_ATTEMPTS_EXHAUSTED' WHERE delivery_id=$1 AND kind='delivery'`,
      [second.deliveryId],
    );
    await expect(repo.shouldWake(second.deliveryId)).resolves.toBe(true);
    const exact = await Promise.all([
      runner.process('exact-a', {
        name: 'private-delivery.wakeup',
        data: { delivery_id: delivery.deliveryId },
      }),
      runner.process('exact-b', {
        name: 'private-delivery.wakeup',
        data: { delivery_id: second.deliveryId },
      }),
    ]);
    expect(exact).toEqual(['idle', 'delivered']);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM private_delivery.deliveries WHERE id IN ($1,$2) AND state='delivered'`,
          [delivery.deliveryId, second.deliveryId],
        )
      ).rows[0].count,
    ).toBe(2);
  }, 30_000);
});
