import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner, parsePepper, PgConnectionRepository, createPool } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

declare const WAI_MIGRATIONS_DIR: string;

let started: StartedInfra;
let pool: Pool;
let repo: PgConnectionRepository;
let runner: MigrationRunner;

const account = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const connection = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function insertAccount(id: string) {
  await pool.query(
    `INSERT INTO iam.accounts (id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id)
     VALUES ($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')`,
    [id, id.replaceAll('-', '')],
  );
}

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, { through: '0009_connection.sql' });
  await runner.up();
  repo = new PgConnectionRepository(pool, parsePepper('con-test-pepper-012345678901234567890123'));
});
afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('CON-01 real PostgreSQL connection graph', () => {
  it('serializes concurrent reciprocal requests into one canonical pair', async () => {
    const a = account(1),
      b = account(2);
    await insertAccount(a);
    await insertAccount(b);
    const [first, second] = await Promise.allSettled([
      repo.createRequest({
        actorAccountId: a,
        recipientAccountId: b,
        mode: 'friends',
        idempotencyKey: 'request-a-00000001',
      }),
      repo.createRequest({
        actorAccountId: b,
        recipientAccountId: a,
        mode: 'friends',
        idempotencyKey: 'request-b-00000001',
      }),
    ]);
    expect([first, second].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await pool.query(
      'SELECT account_a,account_b,state FROM connection.connections WHERE account_a=$1 AND account_b=$2',
      [a, b],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].state).toBe('pending');
  });

  it('replays idempotency and rejects a conflicting payload', async () => {
    const a = account(3),
      b = account(4);
    await insertAccount(a);
    await insertAccount(b);
    const input = {
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'events' as const,
      idempotencyKey: 'request-a-00000002',
    };
    const first = await repo.createRequest(input);
    const replay = await repo.createRequest(input);
    expect(replay.id).toBe(first.id);
    const stored = await pool.query<{ idempotency_digest: string }>(
      `SELECT idempotency_digest FROM connection.idempotency_keys
       WHERE actor_account_id=$1 AND operation='create'`,
      [a],
    );
    expect(stored.rows[0]?.idempotency_digest).not.toBe(
      createHash('sha256').update(input.idempotencyKey).digest('hex'),
    );
    await expect(repo.createRequest({ ...input, mode: 'dating' })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('replays the original frozen request after the connection changes state', async () => {
    const a = account(25),
      b = account(26);
    await insertAccount(a);
    await insertAccount(b);
    const input = {
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends' as const,
      idempotencyKey: 'request-a-frozen-00025',
    };
    const first = await repo.createRequest(input);
    await repo.transition({
      connectionId: first.id,
      actorAccountId: b,
      action: 'accept',
      idempotencyKey: 'action-b-frozen-00025',
    });
    const replay = await repo.createRequest(input);
    expect(replay).toEqual(first);
    expect(replay.state).toBe('pending');
  });

  it('rejects direct repository creation when an active block already exists', async () => {
    const a = account(27),
      b = account(28);
    await insertAccount(a);
    await insertAccount(b);
    await pool.query(
      `INSERT INTO safety.blocks (id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at)
       VALUES ($1,$2,$3,'safety_concern',$4,$5,'active',now())`,
      [connection(27), a, b, 'c'.repeat(64), 'd'.repeat(64)],
    );
    await expect(
      repo.createRequest({
        actorAccountId: a,
        recipientAccountId: b,
        mode: 'friends',
        idempotencyKey: 'request-a-blocked-00027',
      }),
    ).rejects.toThrow('ACTIVE_BLOCK');
    const rows = await pool.query(
      'SELECT count(*)::int AS count FROM connection.connections WHERE account_a=$1 AND account_b=$2',
      [a, b],
    );
    expect(rows.rows[0].count).toBe(0);
    const idempotency = await pool.query(
      `SELECT count(*)::int AS count FROM connection.idempotency_keys WHERE actor_account_id=$1`,
      [a],
    );
    expect(idempotency.rows[0].count).toBe(0);
  });

  it('persists decline and disconnect as the final escape states', async () => {
    const a = account(19),
      b = account(20),
      c = account(21),
      d = account(22);
    await Promise.all([a, b, c, d].map(insertAccount));
    const declined = await repo.createRequest({
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends',
      idempotencyKey: 'request-a-00000019',
    });
    const declinedResult = await repo.transition({
      connectionId: declined.id,
      actorAccountId: b,
      action: 'decline',
      idempotencyKey: 'action-b-00000019',
    });
    expect(declinedResult.state).toBe('declined');
    const disconnected = await repo.createRequest({
      actorAccountId: c,
      recipientAccountId: d,
      mode: 'friends',
      idempotencyKey: 'request-c-00000021',
    });
    await repo.transition({
      connectionId: disconnected.id,
      actorAccountId: d,
      action: 'accept',
      idempotencyKey: 'action-d-00000021',
    });
    const disconnectedResult = await repo.transition({
      connectionId: disconnected.id,
      actorAccountId: c,
      action: 'disconnect',
      idempotencyKey: 'action-c-00000021',
    });
    expect(disconnectedResult.state).toBe('disconnected');
  });

  it('serializes same-key accept and disconnect replays to one transition', async () => {
    const a = account(13),
      b = account(14);
    await insertAccount(a);
    await insertAccount(b);
    const pending = await repo.createRequest({
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends',
      idempotencyKey: 'request-a-00000013',
    });
    const accepts = await Promise.all([
      repo.transition({
        connectionId: pending.id,
        actorAccountId: b,
        action: 'accept',
        idempotencyKey: 'action-b-same-00013',
      }),
      repo.transition({
        connectionId: pending.id,
        actorAccountId: b,
        action: 'accept',
        idempotencyKey: 'action-b-same-00013',
      }),
    ]);
    expect(accepts[0]).toEqual(accepts[1]);
    const acceptedTransitions = await pool.query(
      `SELECT count(*)::int AS count FROM connection.transitions
       WHERE connection_id=$1 AND reason='accept'`,
      [pending.id],
    );
    expect(acceptedTransitions.rows[0].count).toBe(1);
    const acceptedIdempotency = await pool.query(
      `SELECT count(*)::int AS count FROM connection.idempotency_keys
       WHERE actor_account_id=$1 AND operation='accept'`,
      [b],
    );
    expect(acceptedIdempotency.rows[0].count).toBe(1);

    const disconnects = await Promise.all([
      repo.transition({
        connectionId: pending.id,
        actorAccountId: a,
        action: 'disconnect',
        idempotencyKey: 'action-a-same-00013',
      }),
      repo.transition({
        connectionId: pending.id,
        actorAccountId: a,
        action: 'disconnect',
        idempotencyKey: 'action-a-same-00013',
      }),
    ]);
    expect(disconnects[0]).toEqual(disconnects[1]);
    const disconnectTransitions = await pool.query(
      `SELECT count(*)::int AS count FROM connection.transitions
       WHERE connection_id=$1 AND reason='disconnect'`,
      [pending.id],
    );
    expect(disconnectTransitions.rows[0].count).toBe(1);
  });

  it('requires recipient acceptance, uses accepted graph, and invalidates on block', async () => {
    const a = account(5),
      b = account(6);
    await insertAccount(a);
    await insertAccount(b);
    const pending = await repo.createRequest({
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends',
      idempotencyKey: 'request-a-00000003',
    });
    await expect(
      repo.transition({
        connectionId: pending.id,
        actorAccountId: a,
        action: 'accept',
        idempotencyKey: 'action-a-00000003',
      }),
    ).rejects.toThrow('CONNECTION_ACTION_FORBIDDEN');
    const accepted = await repo.transition({
      connectionId: pending.id,
      actorAccountId: b,
      action: 'accept',
      idempotencyKey: 'action-b-00000003',
    });
    expect(accepted.state).toBe('accepted');
    expect(await repo.relationship(a, b)).toEqual({ relationship: 'connection' });
    await pool.query(
      `INSERT INTO safety.blocks (id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at)
       VALUES ($1,$2,$3,'safety_concern',$4,$5,'active',now())`,
      [connection(5), a, b, 'a'.repeat(64), 'b'.repeat(64)],
    );
    expect(await repo.relationship(a, b)).toEqual({ relationship: 'none' });
    const row = await pool.query('SELECT state FROM connection.connections WHERE id=$1', [
      pending.id,
    ]);
    expect(row.rows[0].state).toBe('invalidated');
    const acceptedReplay = await repo.transition({
      connectionId: pending.id,
      actorAccountId: b,
      action: 'accept',
      idempotencyKey: 'action-b-00000003',
    });
    expect(acceptedReplay.state).toBe('accepted');
    expect(
      (
        await repo.createRequest({
          actorAccountId: a,
          recipientAccountId: b,
          mode: 'friends',
          idempotencyKey: 'request-a-00000003',
        })
      ).state,
    ).toBe('pending');
    await pool.query(`UPDATE safety.blocks SET state='revoked',revoked_at=now() WHERE id=$1`, [
      connection(5),
    ]);
    expect(await repo.relationship(a, b)).toEqual({ relationship: 'none' });
  });

  it('allows a new explicit consent epoch only after the old epoch cooldown', async () => {
    const a = account(7),
      b = account(8);
    await insertAccount(a);
    await insertAccount(b);
    const first = await repo.createRequest({
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends',
      idempotencyKey: 'request-a-00000004',
    });
    await repo.transition({
      connectionId: first.id,
      actorAccountId: b,
      action: 'accept',
      idempotencyKey: 'action-b-00000004',
    });
    await repo.transition({
      connectionId: first.id,
      actorAccountId: a,
      action: 'disconnect',
      idempotencyKey: 'action-a-00000004',
    });
    await expect(
      repo.createRequest({
        actorAccountId: a,
        recipientAccountId: b,
        mode: 'friends',
        idempotencyKey: 'request-a-00000005',
      }),
    ).rejects.toThrow('PAIR_COOLDOWN');
    await pool.query(
      `UPDATE connection.connections SET cooldown_until=now()-interval '1 second' WHERE id=$1`,
      [first.id],
    );
    const second = await repo.createRequest({
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends',
      idempotencyKey: 'request-a-00000005',
    });
    expect(second.id).not.toBe(first.id);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM connection.connections WHERE account_a=$1 AND account_b=$2',
          [a, b],
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it('paginates actor history with a stable created-at/id cursor', async () => {
    const actor = account(15);
    const peers = [account(16), account(17), account(18)];
    await insertAccount(actor);
    for (const [index, peer] of peers.entries()) {
      await insertAccount(peer);
      await repo.createRequest({
        actorAccountId: actor,
        recipientAccountId: peer,
        mode: 'friends',
        idempotencyKey: `request-a-page-${index}-00015`,
      });
    }
    const first = await repo.listForActor(actor, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await repo.listForActor(actor, { limit: 2, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(1);
    expect(new Set(second.rows.map((row) => row.id))).not.toEqual(
      new Set(first.rows.map((row) => row.id)),
    );
    expect(second.nextCursor).toBeNull();
    await expect(repo.listForActor(actor, { limit: 2, cursor: 'bad-cursor' })).rejects.toThrow(
      'INVALID_CURSOR',
    );
  });

  it('keeps transitions append-only while allowing account erasure cascades', async () => {
    const a = account(23),
      b = account(24);
    await insertAccount(a);
    await insertAccount(b);
    const created = await repo.createRequest({
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends',
      idempotencyKey: 'request-a-00000023',
    });
    await expect(
      pool.query('DELETE FROM connection.transitions WHERE connection_id=$1', [created.id]),
    ).rejects.toThrow(/append-only/);
    await pool.query('DELETE FROM iam.accounts WHERE id=$1', [a]);
    const remaining = await pool.query(
      `SELECT
         (SELECT count(*) FROM connection.connections WHERE id=$1)::int AS connections,
         (SELECT count(*) FROM connection.transitions WHERE connection_id=$1)::int AS transitions,
         (SELECT count(*) FROM connection.idempotency_keys WHERE connection_id=$1)::int AS idempotency`,
      [created.id],
    );
    expect(remaining.rows[0]).toEqual({ connections: 0, transitions: 0, idempotency: 0 });
  });

  it('rejects direct mode mutation without changing state or version', async () => {
    const a = account(29),
      b = account(30);
    await insertAccount(a);
    await insertAccount(b);
    const created = await repo.createRequest({
      actorAccountId: a,
      recipientAccountId: b,
      mode: 'friends',
      idempotencyKey: 'request-a-00000029',
    });
    await expect(
      pool.query(`UPDATE connection.connections SET mode='dating' WHERE id=$1`, [created.id]),
    ).rejects.toThrow(/connection identity is immutable/);
    const row = await pool.query<{ mode: string; state: string; version: number }>(
      'SELECT mode,state,version FROM connection.connections WHERE id=$1',
      [created.id],
    );
    expect(row.rows[0]).toEqual({ mode: 'friends', state: 'pending', version: 0 });
  });

  it('is fresh/no-op/down/up reversible for the fixed migration', async () => {
    const noop = await runner.up();
    expect(noop.applied).toHaveLength(0);
    expect(noop.skipped).toContain('0009_connection.sql');
    expect(await runner.down()).toBe('0009_connection.sql');
    const reapplied = await runner.up();
    expect(reapplied.applied).toContain('0009_connection.sql');
  });
});
