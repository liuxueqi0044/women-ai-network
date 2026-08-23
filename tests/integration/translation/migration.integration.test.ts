import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { MigrationRunner, PgTranslationRepository, createPool } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { PgTranslationAuthorization } from '../../../apps/worker/src/translation/authorization.js';
import { TranslationWakeReconciler } from '../../../apps/worker/src/translation/reconciler.js';
import type { TranslationTask } from '@wai/contracts';

declare const WAI_MIGRATIONS_DIR: string;
let infra: StartedInfra;
let pool: Pool;
let runner: MigrationRunner;
const accountId = '11111111-1111-4111-8111-111111111111';
const viewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondViewerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const thirdViewerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const letterId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const sourceHash = 'a'.repeat(64);
const publicLetterId = '77777777-7777-4777-8777-777777777777';
const publicRevisionId = '88888888-8888-4888-8888-888888888888';
const publicPublicationId = '99999999-9999-4999-8999-999999999999';
const publicSourceHash = 'c'.repeat(64);

beforeAll(async () => {
  infra = await startTestInfra();
  pool = createPool(infra.infra.databaseUrl);
  runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, { through: '0011_translation.sql' });
  await runner.up();
  const now = new Date();
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at)
     VALUES ($1,$2,'x','x','k','enabled','registered','system',$3,0,$3,$3)`,
    [accountId, 'b'.repeat(64), now],
  );
  await client.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at)
     VALUES ($1,$2,'x','x','k','enabled','registered','system',$3,0,$3,$3)`,
    [viewerId, 'd'.repeat(64), now],
  );
  await client.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at)
     VALUES ($1,$2,'x','x','k','enabled','registered','system',$3,0,$3,$3)`,
    [secondViewerId, 'e'.repeat(64), now],
  );
  await client.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at)
     VALUES ($1,$2,'x','x','k','enabled','registered','system',$3,0,$3,$3)`,
    [thirdViewerId, 'f'.repeat(64), now],
  );
  await client.query(
    `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at)
     VALUES ($1,$2,'private_letter','draft',1,1,$3,$3)`,
    [letterId, accountId, now],
  );
  await client.query(
    `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at)
     VALUES ($1,$2,1,$3,'x','x','x','x','x','x','k',$4)`,
    [revisionId, letterId, sourceHash, now],
  );
  await client.query('COMMIT');
  client.release();
});

afterAll(async () => {
  await pool?.end();
  await infra?.stop();
});

describe('TRL-01 real PostgreSQL lifecycle guards', () => {
  it('rejects direct non-queued task insertion and preserves frozen idempotency replay', async () => {
    await pool.query(
      `INSERT INTO translation.consents(id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at) VALUES ('44444444-4444-4444-8444-444444444445',$1,'private_letter',$2,$3,$4,'test','v1','us','zero',0,'private_translation',true,now()+interval '1 hour',NULL,now())`,
      [accountId, letterId, revisionId, sourceHash],
    );
    await expect(
      pool.query(
        `INSERT INTO translation.tasks(id,owner_id,source_kind,letter_id,source_revision_id,source_revision,source_hash,source_locale,target_locale,provider_id,provider_version,consent_id,consent_provider_version,consent_processing_region,consent_retention_policy,consent_retention_seconds,state,request_digest,key_digest,attempts,max_attempts,created_at,updated_at)
       VALUES ('44444444-4444-4444-8444-444444444444',$1,'private_letter',$2,$3,1,$4,'en-US','fr-FR','test','v1','44444444-4444-4444-8444-444444444445','v1','us','zero',0,'ready',$5,$6,0,3,now(),now())`,
        [accountId, letterId, revisionId, sourceHash, 'c'.repeat(64), 'd'.repeat(64)],
      ),
    ).rejects.toThrow(/initial state|translation task/i);

    const repository = new PgTranslationRepository(pool, {
      keyId: 'translation-v1',
      key: Buffer.alloc(32, 7),
      hmacKey: Buffer.alloc(32, 8),
    });
    const key = {
      source_kind: 'private_letter' as const,
      letter_id: letterId,
      source_revision_id: revisionId,
      source_revision: 1,
      source_hash: sourceHash,
      source_locale: 'en-US',
      target_locale: 'fr-FR',
      provider_id: 'test',
      provider_version: 'v1',
    };
    const created = await repository.createOrReplay({
      ownerId: accountId,
      key,
      requestDigest: 'e'.repeat(64),
      idempotencyKey: 'idempotency-translation-001',
      consent: {
        id: '44444444-4444-4444-8444-444444444445',
        providerVersion: 'v1',
        processingRegion: 'us',
        retentionPolicy: 'zero',
        retentionSeconds: 0,
      },
    });
    expect(created.task.state).toBe('queued');
    await expect(
      pool.query('SELECT task_id,attempt FROM translation.retry_wakeups WHERE task_id=$1', [
        created.task.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ task_id: created.task.id, attempt: 0 }] });
    const consentInput = (id: string) => ({
      id,
      owner_id: accountId,
      source_kind: 'private_letter' as const,
      letter_id: letterId,
      source_revision_id: revisionId,
      source_hash: sourceHash,
      provider_id: 'concurrent',
      provider_version: 'v1',
      processing_region: 'us',
      retention_policy: 'zero' as const,
      retention_seconds: 0,
      capability: 'private_translation' as const,
      no_training: true as const,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
      created_at: new Date().toISOString(),
    });
    const [consentA, consentB] = await Promise.all([
      repository.saveConsent(consentInput('77777777-7777-4777-8777-777777777777')),
      repository.saveConsent(consentInput('88888888-8888-4888-8888-888888888888')),
    ]);
    expect(consentA.id).toBe(consentB.id);
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM translation.consents WHERE owner_id=$1 AND provider_id='concurrent' AND revoked_at IS NULL`,
        [accountId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    const replay = await repository.replay({
      ownerId: accountId,
      requestDigest: 'e'.repeat(64),
      idempotencyKey: 'idempotency-translation-001',
    });
    expect(replay !== null && 'task' in replay ? replay.task.state : null).toBe('queued');
  });

  it('rejects completion after lease expiry and stale token', async () => {
    const repository = new PgTranslationRepository(pool, {
      keyId: 'translation-v1',
      key: Buffer.alloc(32, 7),
      hmacKey: Buffer.alloc(32, 8),
    });
    const key = {
      source_kind: 'private_letter' as const,
      letter_id: letterId,
      source_revision_id: revisionId,
      source_revision: 1,
      source_hash: sourceHash,
      source_locale: 'en-US',
      target_locale: 'de-DE',
      provider_id: 'test2',
      provider_version: 'v1',
    };
    await pool.query(
      `INSERT INTO translation.consents(id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at) VALUES ('55555555-5555-4555-8555-555555555555',$1,'private_letter',$2,$3,$4,'test2','v1','us','zero',0,'private_translation',true,now()+interval '1 hour',NULL,now())`,
      [accountId, letterId, revisionId, sourceHash],
    );
    const created = await repository.createOrReplay({
      ownerId: accountId,
      key,
      requestDigest: 'f'.repeat(64),
      idempotencyKey: 'idempotency-translation-002',
      consent: {
        id: '55555555-5555-4555-8555-555555555555',
        providerVersion: 'v1',
        processingRegion: 'us',
        retentionPolicy: 'zero',
        retentionSeconds: 0,
      },
    });
    let leased = await repository.claim({ workerId: 'worker', now: new Date(), leaseSeconds: 0 });
    while (leased !== null && leased.id !== created.task.id) {
      if (leased.leaseToken !== null)
        await repository.fail({
          taskId: leased.id,
          leaseToken: leased.leaseToken,
          errorCode: 'SKIP',
          now: new Date(),
        });
      leased = await repository.claim({ workerId: 'worker', now: new Date(), leaseSeconds: 0 });
    }
    expect(leased?.id).toBe(created.task.id);
    await expect(
      pool.query('SELECT count(*)::int AS count FROM translation.retry_wakeups WHERE task_id=$1', [
        created.task.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      repository.complete({
        taskId: leased!.id,
        leaseToken: leased!.leaseToken!,
        output: { schema_version: 1, target_locale: 'de-DE', title: 'Hallo', paragraphs: ['Welt'] },
      }),
    ).resolves.toBe(false);
    const expiredAt = new Date(Date.now() + 1_000);
    await expect(
      repository.claim({
        workerId: 'stalled-queue-worker',
        now: expiredAt,
        leaseSeconds: 60,
        taskId: created.task.id,
      }),
    ).resolves.toBeNull();
    const [recoveredFirst, recoveredSecond] = await Promise.all([
      repository.reapExpiredLeases({ now: expiredAt, limit: 100 }),
      repository.reapExpiredLeases({ now: expiredAt, limit: 100 }),
    ]);
    const recovered = [...recoveredFirst, ...recoveredSecond];
    const recoveredTask = recovered.find((task) => task.taskId === created.task.id);
    expect(recoveredTask).toBeDefined();
    expect(recovered.filter((task) => task.taskId === created.task.id)).toHaveLength(1);
    expect((await repository.findTask(created.task.id))?.state).toBe('retry_wait');
    const queued: unknown[][] = [];
    const wakeAt = recoveredTask!.nextRetryAt;
    const reconciler = new TranslationWakeReconciler(
      repository,
      {
        add: async (...args: unknown[]) => {
          queued.push(args);
          return undefined;
        },
      } as never,
      1_000,
      () => wakeAt,
    );
    await (reconciler as unknown as { reconcile(): Promise<void> }).reconcile();
    expect(
      queued.some(
        (entry) =>
          entry[0] === 'translation.process' &&
          JSON.stringify(entry[1]) === JSON.stringify({ task_id: created.task.id }) &&
          (entry[2] as { jobId?: string }).jobId === `${created.task.id}:wake:1`,
      ),
    ).toBe(true);
    const reclaimed = await repository.claim({
      workerId: 'replacement-worker',
      now: new Date(wakeAt.getTime() + 1),
      leaseSeconds: 60,
      taskId: created.task.id,
    });
    expect(reclaimed?.attempts).toBe(2);
    await expect(
      pool.query('SELECT count(*)::int AS count FROM translation.retry_wakeups WHERE task_id=$1', [
        created.task.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    const secondRecovery = await repository.reapExpiredLeases({
      now: new Date(reclaimed!.leaseUntil!.getTime() + 1),
      limit: 100,
    });
    const secondWakeAt = secondRecovery.find(
      (task) => task.taskId === created.task.id,
    )!.nextRetryAt;
    const finalLease = await repository.claim({
      workerId: 'final-worker',
      now: new Date(secondWakeAt.getTime() + 1),
      leaseSeconds: 60,
      taskId: created.task.id,
    });
    expect(finalLease?.attempts).toBe(3);
    const terminalAt = new Date(finalLease!.leaseUntil!.getTime() + 1);
    await expect(repository.reapExpiredLeases({ now: terminalAt, limit: 100 })).resolves.toEqual(
      [],
    );
    expect((await repository.findTask(created.task.id))?.state).toBe('failed');
    await expect(
      pool.query('SELECT count(*)::int AS count FROM translation.retry_wakeups WHERE task_id=$1', [
        created.task.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('coalesces concurrent cache creation and detects encrypted result tampering across key rotation', async () => {
    await pool.query(
      `INSERT INTO translation.consents(id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at) VALUES ('66666666-6666-4666-8666-666666666666',$1,'private_letter',$2,$3,$4,'test3','v1','us','zero',0,'private_translation',true,now()+interval '1 hour',NULL,now())`,
      [accountId, letterId, revisionId, sourceHash],
    );
    const repository = new PgTranslationRepository(pool, {
      keyId: 'translation-v1',
      key: Buffer.alloc(32, 7),
      hmacKey: Buffer.alloc(32, 8),
    });
    const key = {
      source_kind: 'private_letter' as const,
      letter_id: letterId,
      source_revision_id: revisionId,
      source_revision: 1,
      source_hash: sourceHash,
      source_locale: 'en-US',
      target_locale: 'it-IT',
      provider_id: 'test3',
      provider_version: 'v1',
    };
    const [a, b] = await Promise.all([
      repository.createOrReplay({
        ownerId: accountId,
        key,
        requestDigest: '1'.repeat(64),
        idempotencyKey: 'idempotency-translation-003',
        consent: {
          id: '66666666-6666-4666-8666-666666666666',
          providerVersion: 'v1',
          processingRegion: 'us',
          retentionPolicy: 'zero',
          retentionSeconds: 0,
        },
      }),
      repository.createOrReplay({
        ownerId: accountId,
        key,
        requestDigest: '2'.repeat(64),
        idempotencyKey: 'idempotency-translation-004',
        consent: {
          id: '66666666-6666-4666-8666-666666666666',
          providerVersion: 'v1',
          processingRegion: 'us',
          retentionPolicy: 'zero',
          retentionSeconds: 0,
        },
      }),
    ]);
    expect(a.task.id).toBe(b.task.id);
    let leased = await repository.claim({ workerId: 'worker', now: new Date(), leaseSeconds: 60 });
    while (leased !== null && leased.id !== a.task.id) {
      if (leased.leaseToken !== null)
        await repository.fail({
          taskId: leased.id,
          leaseToken: leased.leaseToken,
          errorCode: 'SKIP',
          now: new Date(),
        });
      leased = await repository.claim({ workerId: 'worker', now: new Date(), leaseSeconds: 60 });
    }
    expect(leased?.leaseToken).not.toBeNull();
    await expect(
      repository.complete({
        taskId: a.task.id,
        leaseToken: leased!.leaseToken!,
        output: { schema_version: 1, target_locale: 'it-IT', title: 'Ciao', paragraphs: ['Mondo'] },
      }),
    ).resolves.toBe(true);
    await expect(repository.read({ taskId: a.task.id })).resolves.toMatchObject({ title: 'Ciao' });

    const rotated = new PgTranslationRepository(pool, {
      keyId: 'translation-v2',
      key: Buffer.alloc(32, 9),
      keys: new Map([
        ['translation-v1', Buffer.alloc(32, 7)],
        ['translation-v2', Buffer.alloc(32, 9)],
      ]),
      hmacKey: Buffer.alloc(32, 8),
    });
    await expect(rotated.read({ taskId: a.task.id })).resolves.toMatchObject({ title: 'Ciao' });
    await pool.query(
      'ALTER TABLE translation.results DISABLE TRIGGER translation_results_append_only',
    );
    await pool.query(
      `UPDATE translation.results SET title_ciphertext='tampered' WHERE task_id=$1`,
      [a.task.id],
    );
    await pool.query(
      'ALTER TABLE translation.results ENABLE TRIGGER translation_results_append_only',
    );
    await expect(rotated.read({ taskId: a.task.id })).rejects.toThrow();
  });

  it('translation_never_overwrites_canonical_source; withdrawal_or_block_hides_cached_translation and allows consent revoke/regrant without deletion', async () => {
    const now = new Date();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at)
         VALUES ($1,$2,'public_letter','draft',1,1,$3,$3)`,
        [publicLetterId, accountId, now],
      );
      await client.query(
        `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at)
         VALUES ($1,$2,1,$3,'x','x','x','x','x','x','k',$4)`,
        [publicRevisionId, publicLetterId, publicSourceHash, now],
      );
      await client.query(
        `UPDATE letters.letters SET state='published',version=2,published_at=$2,updated_at=$2 WHERE id=$1`,
        [publicLetterId, now],
      );
      await client.query(
        `INSERT INTO letters.publications(id,letter_id,revision_id,source_hash,projection_json,published_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          publicPublicationId,
          publicLetterId,
          publicRevisionId,
          publicSourceHash,
          JSON.stringify({ id: publicLetterId, revision: 1 }),
          now,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const repository = new PgTranslationRepository(pool, {
      keyId: 'translation-v1',
      key: Buffer.alloc(32, 7),
      hmacKey: Buffer.alloc(32, 8),
    });
    const created = await repository.createOrReplay({
      ownerId: viewerId,
      key: {
        source_kind: 'public_letter',
        letter_id: publicLetterId,
        source_revision_id: publicRevisionId,
        source_revision: 1,
        source_hash: publicSourceHash,
        source_locale: 'en-US',
        target_locale: 'fr-FR',
        provider_id: 'public-test',
        provider_version: 'v1',
      },
      requestDigest: '7'.repeat(64),
      idempotencyKey: 'idempotency-public-cross-member-001',
    });
    expect(created.task.ownerId).toBe(viewerId);
    const leased = await repository.claim({
      workerId: 'worker-public',
      now: new Date(),
      leaseSeconds: 60,
      taskId: created.task.id,
    });
    expect(leased?.leaseToken).not.toBeNull();
    await expect(
      repository.complete({
        taskId: created.task.id,
        leaseToken: leased!.leaseToken!,
        output: {
          schema_version: 1,
          target_locale: 'fr-FR',
          title: 'Bonjour',
          paragraphs: ['Salut'],
        },
      }),
    ).resolves.toBe(true);
    await expect(repository.read({ taskId: created.task.id })).resolves.toMatchObject({
      title: 'Bonjour',
    });
    await expect(
      pool.query('SELECT owner_id FROM translation.tasks WHERE id=$1', [created.task.id]),
    ).resolves.toMatchObject({ rows: [{ owner_id: viewerId }] });
    const shared = await repository.createOrReplay({
      ownerId: secondViewerId,
      key: {
        source_kind: 'public_letter',
        letter_id: publicLetterId,
        source_revision_id: publicRevisionId,
        source_revision: 1,
        source_hash: publicSourceHash,
        source_locale: 'en-US',
        target_locale: 'fr-FR',
        provider_id: 'public-test',
        provider_version: 'v1',
      },
      requestDigest: '9'.repeat(64),
      idempotencyKey: 'idempotency-public-second-viewer-001',
    });
    expect(shared.created).toBe(false);
    expect(shared.task.id).toBe(created.task.id);
    const concurrentKey = {
      source_kind: 'public_letter' as const,
      letter_id: publicLetterId,
      source_revision_id: publicRevisionId,
      source_revision: 1,
      source_hash: publicSourceHash,
      source_locale: 'en-US',
      target_locale: 'ja-JP',
      provider_id: 'public-concurrent',
      provider_version: 'v1',
    };
    const [concurrentB, concurrentC] = await Promise.all([
      repository.createOrReplay({
        ownerId: secondViewerId,
        key: concurrentKey,
        requestDigest: 'a'.repeat(64),
        idempotencyKey: 'idempotency-public-concurrent-b-001',
      }),
      repository.createOrReplay({
        ownerId: thirdViewerId,
        key: concurrentKey,
        requestDigest: 'b'.repeat(64),
        idempotencyKey: 'idempotency-public-concurrent-c-001',
      }),
    ]);
    expect(concurrentB.task.id).toBe(concurrentC.task.id);
    expect([concurrentB.created, concurrentC.created].filter(Boolean)).toHaveLength(1);
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM translation.tasks
          WHERE source_kind='public_letter' AND letter_id=$1 AND target_locale='ja-JP' AND provider_id='public-concurrent'`,
        [publicLetterId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM translation.idempotency_keys
          WHERE owner_id IN ($1,$2) AND result_json->'task'->>'id'=$3`,
        [secondViewerId, thirdViewerId, concurrentB.task.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(
      pool.query(`SELECT source_hash,title_ciphertext FROM letters.letter_revisions WHERE id=$1`, [
        publicRevisionId,
      ]),
    ).resolves.toMatchObject({ rows: [{ source_hash: publicSourceHash, title_ciphertext: 'x' }] });

    await pool.query(
      `UPDATE letters.letters SET state='withdrawn',version=3,withdrawn_at=now(),updated_at=now() WHERE id=$1`,
      [publicLetterId],
    );
    await expect(repository.read({ taskId: created.task.id })).resolves.toBeNull();

    const consentA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const consentB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await pool.query(
      `INSERT INTO translation.consents(id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at)
       VALUES ($1,$2,'private_letter',$3,$4,$5,'regrant','v1','us','zero',0,'private_translation',true,now()+interval '1 hour',NULL,now())`,
      [consentA, accountId, letterId, revisionId, sourceHash],
    );
    await pool.query(`UPDATE translation.consents SET revoked_at=now() WHERE id=$1`, [consentA]);
    await expect(
      pool.query(`DELETE FROM translation.consents WHERE id=$1`, [consentA]),
    ).rejects.toThrow(/immutable|append/i);
    await pool.query(
      `INSERT INTO translation.consents(id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at)
       VALUES ($1,$2,'private_letter',$3,$4,$5,'regrant','v1','us','zero',0,'private_translation',true,now()+interval '1 hour',NULL,now())`,
      [consentB, accountId, letterId, revisionId, sourceHash],
    );
    const active = await pool.query(
      `SELECT count(*)::int AS count FROM translation.consents WHERE provider_id='regrant' AND revoked_at IS NULL`,
    );
    expect(active.rows[0]?.count).toBe(1);

    const mismatchConsent = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await pool.query(
      `INSERT INTO translation.consents(id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at)
       VALUES ($1,$2,'private_letter',$3,$4,$5,'mismatch','v1','us','zero',0,'private_translation',true,now()+interval '1 hour',NULL,now())`,
      [mismatchConsent, accountId, letterId, revisionId, sourceHash],
    );
    const mismatch = await repository.createOrReplay({
      ownerId: accountId,
      key: {
        source_kind: 'private_letter',
        letter_id: letterId,
        source_revision_id: revisionId,
        source_revision: 1,
        source_hash: sourceHash,
        source_locale: 'en-US',
        target_locale: 'ja-JP',
        provider_id: 'mismatch',
        provider_version: 'v1',
      },
      requestDigest: '8'.repeat(64),
      idempotencyKey: 'idempotency-mismatch-001',
      consent: {
        id: mismatchConsent,
        providerVersion: 'v1',
        processingRegion: 'us',
        retentionPolicy: 'zero',
        retentionSeconds: 0,
      },
    });
    const mismatchLease = await repository.claim({
      workerId: 'worker-mismatch',
      now: new Date(),
      leaseSeconds: 60,
      taskId: mismatch.task.id,
    });
    expect(mismatchLease?.leaseToken).not.toBeNull();
    await pool.query(
      'ALTER TABLE translation.consents DISABLE TRIGGER translation_consents_revoke',
    );
    try {
      await pool.query(`UPDATE translation.consents SET provider_version='v2' WHERE id=$1`, [
        mismatchConsent,
      ]);
    } finally {
      await pool.query(
        'ALTER TABLE translation.consents ENABLE TRIGGER translation_consents_revoke',
      );
    }
    await expect(
      repository.complete({
        taskId: mismatch.task.id,
        leaseToken: mismatchLease!.leaseToken!,
        output: {
          schema_version: 1,
          target_locale: 'ja-JP',
          title: 'こんにちは',
          paragraphs: ['世界'],
        },
      }),
    ).resolves.toBe(false);
  });

  it('uses real PostgreSQL current VER/ELG/membership/SAF facts and rejects a newer partition deny', async () => {
    const now = new Date();
    const policyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const membershipPolicyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const policyClient = await pool.connect();
    try {
      await policyClient.query('BEGIN');
      await policyClient.query(`SELECT set_config('app.eligibility_policy_publish','true',true)`);
      await policyClient.query(
        `INSERT INTO eligibility.jurisdiction_policies(id,jurisdiction_key,revision,status,content,content_hash,rule_hash,timezone,effective_from,effective_until,is_synthetic,retired_at,created_at,location_precision_policy,profiling_policy,retention_policy,legal_basis_refs,reviewed_by,reviewed_at)
         VALUES ($1,'US',1,'approved','{}',$2,$3,'UTC',$4::timestamptz,$4::timestamptz + interval '1 day',false,NULL,$4::timestamptz,'country_only','derived_facts_only','credential_until_superseded',ARRAY['test:legal'],'principal',$4::timestamptz)`,
        [policyId, '1'.repeat(64), '2'.repeat(64), now],
      );
      await policyClient.query('COMMIT');
    } catch (error) {
      await policyClient.query('ROLLBACK');
      throw error;
    } finally {
      policyClient.release();
    }
    await pool.query(
      `INSERT INTO verification.membership_policies(id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,effective_from,effective_until,created_at)
       VALUES ($1,1,'approved',$2,'test','principal',$3::timestamptz,$3::timestamptz,$3::timestamptz + interval '1 day',$3::timestamptz)`,
      [membershipPolicyId, '3'.repeat(64), now],
    );
    for (const [account, suffix] of [
      [accountId, '1'],
      [viewerId, '2'],
    ] as const) {
      const identityId = `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
      const evidenceId = `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
      const credentialId = `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-9${suffix.repeat(3)}-${suffix.repeat(12)}`;
      const membershipId = `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-a${suffix.repeat(3)}-${suffix.repeat(12)}`;
      await pool.query(
        `INSERT INTO verification.identity_cases(id,account_id,state,age_assurance_state,version,created_at,updated_at,verified_at)
         VALUES ($1,$2,'verified','attested',1,$3::timestamptz,$3::timestamptz,$3::timestamptz)`,
        [identityId, account, now],
      );
      await pool.query(
        `INSERT INTO eligibility.age_evidence(id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,superseded_at,created_at,verification_case_id,external_attestation_digest)
         VALUES ($1,$2,$3,'cipher','nonce','k','verification_provider',$4,NULL,$4,$5,$6)`,
        [evidenceId, account, `${suffix}`.repeat(64), now, identityId, `${suffix}`.repeat(64)],
      );
      await pool.query(
        `INSERT INTO eligibility.age_credentials(id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,policy_revision,valid_from,valid_until,superseded_at,derived_at,derivation_version,created_at)
         VALUES ($1,$2,'youth','youth_16','externally_attested','verification_module',$3,$4,1,$5::timestamptz,$5::timestamptz + interval '1 hour',NULL,$5::timestamptz,1,$5::timestamptz)`,
        [credentialId, account, evidenceId, policyId, now],
      );
      await pool.query(
        `INSERT INTO verification.membership_cases(id,account_id,policy_id,policy_revision,policy_content_hash,statement_category,consented_at,state,version,submitted_at,decided_at,created_at,updated_at)
         VALUES ($1,$2,$3,1,$4,'community_participation',$5::timestamptz,'approved',1,$5::timestamptz,$5::timestamptz,$5::timestamptz,$5::timestamptz)`,
        [membershipId, account, membershipPolicyId, '3'.repeat(64), now],
      );
    }
    await pool.query(
      `INSERT INTO eligibility.partition_decisions(decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
       VALUES ($1,$2,$3,'youth','youth_16','youth','youth_16','discover','allow','{}',$4,$4,1,1,$5,$5,$6,$7,1,$7)`,
      [
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        viewerId,
        accountId,
        policyId,
        '1'.repeat(64),
        '4'.repeat(64),
        now,
      ],
    );
    const authSource = {
      letterId: publicLetterId,
      ownerId: accountId,
      kind: 'public_letter' as const,
      state: 'published' as const,
      currentRevision: 1,
      revisionId: publicRevisionId,
      revision: 1,
      sourceHash: publicSourceHash,
      revisionCreatedAt: now,
      content: {
        title: 'hello',
        body: { paragraphs: ['world'] },
        locale: 'en-US',
        country_code: 'US',
        topics: ['life_story'],
        content_reminder: 'none',
        pen_name: 'A',
      },
    };
    const authTask = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ownerId: viewerId,
      key: {
        source_kind: 'public_letter' as const,
        letter_id: publicLetterId,
        source_revision_id: publicRevisionId,
        source_revision: 1,
        source_hash: publicSourceHash,
        source_locale: 'en-US',
        target_locale: 'fr-FR',
        provider_id: 'public-test',
        provider_version: 'v1',
      },
    } as TranslationTask;
    const authorization = new PgTranslationAuthorization(pool, {
      readPublishedRevision: async () => authSource,
    } as never);
    const initialAuthorization = await authorization.authorize(authTask);
    expect(initialAuthorization).toMatchObject({ allowed: true });
    const blockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
    await pool.query(
      `INSERT INTO safety.blocks
        (id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at)
       VALUES ($1,$2,$3,'unwanted_contact',$4,$5,'active',now())`,
      [blockId, viewerId, accountId, '6'.repeat(64), '7'.repeat(64)],
    );
    await expect(authorization.authorize(authTask)).resolves.toMatchObject({
      allowed: false,
      reason: 'denied',
    });
    await pool.query(`UPDATE safety.blocks SET state='revoked',revoked_at=now() WHERE id=$1`, [
      blockId,
    ]);
    await expect(authorization.authorize(authTask)).resolves.toMatchObject({ allowed: true });
    const denyNow = new Date();
    await pool.query(
      `INSERT INTO eligibility.partition_decisions(decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
       VALUES ($1,$2,$3,'youth','youth_16','youth','youth_16','discover','deny',ARRAY['MODE_DISABLED'],$4,$4,1,1,$5,$5,$6,$7,1,$7)`,
      [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
        viewerId,
        accountId,
        policyId,
        '1'.repeat(64),
        '5'.repeat(64),
        denyNow,
      ],
    );
    await expect(authorization.authorize(authTask)).resolves.toMatchObject({
      allowed: false,
      reason: 'denied',
    });
  });

  it('is no-op on second apply and supports down/up of the fixed migration', async () => {
    const noop = await runner.up();
    expect(noop.applied).toEqual([]);
    expect(noop.skipped.at(-1)).toBe('0011_translation.sql');
    expect(await runner.down()).toBe('0011_translation.sql');
    expect(
      (await pool.query("SELECT to_regclass('translation.tasks') AS name")).rows[0]?.name,
    ).toBeNull();
    const reapplied = await runner.up();
    expect(reapplied.applied).toEqual(['0011_translation.sql']);
    expect(
      (await pool.query("SELECT to_regclass('translation.tasks') AS name")).rows[0]?.name,
    ).toBe('translation.tasks');
  });
});
