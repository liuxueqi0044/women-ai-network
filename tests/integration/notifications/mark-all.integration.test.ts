import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { MigrationRunner, PgNotificationRepository, createPool } from '@wai/db';
import type { NotificationResourceGatePort } from '@wai/contracts';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

declare const WAI_MIGRATIONS_DIR: string;

describe('NTF-01 mark-all concurrency', () => {
  let started: StartedInfra;
  let pool: Pool;

  beforeAll(async () => {
    started = await startTestInfra();
    pool = createPool(started.infra.databaseUrl);
    await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await started.stop();
  });

  it('serializes same-account same-key mark-all replays and gives deterministic different-key results', async () => {
    const accountId = randomUUID();
    const notificationId = randomUUID();
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at)
       VALUES($1,$2,'cipher','nonce','test-key','enabled','registered','system',now(),now(),now())`,
      [accountId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO notifications.notifications(id,recipient_account_id,resource_kind,resource_id,event_key,event_version,category,parameters,created_at)
       VALUES($1,$2,'letter',$3,'letter.received',1,'letters',$4,now())`,
      [notificationId, accountId, randomUUID(), { source: 'member' }],
    );
    const gate: NotificationResourceGatePort = { check: async () => ({ allowed: true }) };
    const repository = new PgNotificationRepository(pool, Buffer.alloc(32), gate);

    const sameKey = await Promise.allSettled([
      repository.markAllRead(accountId, 'same-key-123456'),
      repository.markAllRead(accountId, 'same-key-123456'),
    ]);
    expect(sameKey).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 1 },
    ]);

    const differentKeys = await Promise.allSettled([
      repository.markAllRead(accountId, 'different-a-123456'),
      repository.markAllRead(accountId, 'different-b-123456'),
    ]);
    expect(differentKeys).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'fulfilled', value: 0 },
    ]);
  });
});
