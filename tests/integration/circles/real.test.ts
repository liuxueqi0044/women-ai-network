import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner, PgCircleRepository, createPool } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { CircleGrowthGateService } from '../../../apps/api/src/circles/circles-gate.service.js';

declare const WAI_MIGRATIONS_DIR: string;
let started: StartedInfra;
let pool: Pool;
let repo: PgCircleRepository;
const key = Buffer.alloc(32, 7);
const account = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function insertAccount(id: string) {
  await pool.query(
    "INSERT INTO iam.accounts(id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')",
    [id, id.replaceAll('-', '')],
  );
}
beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR, { through: '0019_circles.sql' }).up();
  repo = new PgCircleRepository(pool, new Map([['test-key', key]]), 'test-key', {
    check: async () => ({ allowed: true }),
  });
});
afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('CIR-01 real PostgreSQL authority', () => {
  it('runs the production growth SQL and fails closed without current authority', async () => {
    const owner = account(89);
    await insertAccount(owner);
    const created = await repo.create(
      owner,
      {
        name: 'Gate SQL',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 2,
      },
      'gate-sql-digest',
      'gate-sql-key-00000001',
    );
    const gate = new CircleGrowthGateService(pool, {
      isInteractionAllowed: async () => ({ allowed: true }),
    });
    await expect(
      gate.check({ actorAccountId: owner, circleId: created.id, operation: 'read' }),
    ).resolves.toMatchObject({ allowed: false });
  });
  it('uses the same transaction for the final write authority barrier', async () => {
    const owner = account(90);
    await insertAccount(owner);
    const denied = new PgCircleRepository(pool, new Map([['test-key', key]]), 'test-key', {
      check: async (input) => ({ allowed: input.transaction === undefined }),
    });
    await expect(
      denied.create(
        owner,
        {
          name: 'Denied',
          lifecycle: 'active',
          visibility: 'approval_required',
          mode: 'friends',
          topic_catalog_version: 1,
          scope_kind: 'online',
          topics: ['culture'],
          member_cap: 2,
        },
        'denied-digest',
        'denied-key-00000001',
      ),
    ).rejects.toMatchObject({ message: 'CIRCLE_NOT_FOUND' });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM circles.circles WHERE owner_account_id=$1',
          [owner],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it('creates encrypted circle/note rows and rejects direct audit mutation', async () => {
    const owner = account(1);
    await insertAccount(owner);
    const circle = await repo.create(
      owner,
      {
        name: 'Private',
        description: 'secret-circle',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 3,
      },
      'create-digest',
      'create-key-00000001',
    );
    const note = await repo.addNote(
      owner,
      circle.id,
      'private-note-canary',
      'note-digest',
      'note-key-00000001',
    );
    const rows = await pool.query(
      'SELECT description_ciphertext,body_ciphertext FROM circles.circles c JOIN circles.notes n ON n.circle_id=c.id WHERE c.id=$1',
      [circle.id],
    );
    expect(rows.rows[0].description_ciphertext).not.toContain('secret-circle');
    expect(rows.rows[0].body_ciphertext).not.toContain('private-note-canary');
    await expect(
      pool.query('DELETE FROM circles.audit_events WHERE circle_id=$1', [circle.id]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "BEGIN; SELECT set_config('circles.erasure_account',$2,true); UPDATE circles.audit_events SET metadata='{}'::jsonb WHERE circle_id=$1; COMMIT",
        [circle.id, owner],
      ),
    ).rejects.toThrow();
    expect(note.id).toBeTruthy();
  });
  it('returns a gated detail description after a historical key rotation', async () => {
    const owner = account(191);
    await insertAccount(owner);
    const oldKey = Buffer.alloc(32, 3);
    const stableHmacKey = Buffer.alloc(32, 9);
    const oldRepo = new PgCircleRepository(
      pool,
      new Map([['old', oldKey]]),
      'old',
      {
        check: async () => ({ allowed: true }),
      },
      stableHmacKey,
    );
    const created = await oldRepo.create(
      owner,
      {
        name: 'Rotated detail',
        description: 'decrypt-with-old-key',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 2,
      },
      'rotation-digest',
      'rotation-key-000001',
    );
    await oldRepo.create(
      owner,
      {
        name: 'Cursor rotation',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 2,
      },
      'rotation-cursor-digest',
      'rotation-cursor-key',
    );
    const oldCursor = await oldRepo.list(owner, { limit: 1 });
    expect(oldCursor.next_cursor).not.toBeNull();
    const rotated = new PgCircleRepository(
      pool,
      new Map([
        ['new', Buffer.alloc(32, 4)],
        ['old', oldKey],
      ]),
      'new',
      {
        check: async () => ({ allowed: true }),
      },
      stableHmacKey,
    );
    await expect(rotated.get(owner, created.id)).resolves.toMatchObject({
      description: 'decrypt-with-old-key',
    });
    await expect(
      rotated.list(owner, { limit: 1, cursor: oldCursor.next_cursor! }),
    ).resolves.toMatchObject({ items: expect.any(Array) });
    await expect(
      rotated.create(
        owner,
        {
          name: 'Rotated detail',
          description: 'decrypt-with-old-key',
          lifecycle: 'active',
          visibility: 'approval_required',
          mode: 'friends',
          topic_catalog_version: 1,
          scope_kind: 'online',
          topics: ['culture'],
          member_cap: 2,
        },
        'rotation-digest',
        'rotation-key-000001',
      ),
    ).resolves.toMatchObject({ id: created.id });
    await expect(
      rotated.create(
        owner,
        {
          name: 'rotated payload conflict',
          lifecycle: 'active',
          visibility: 'approval_required',
          mode: 'friends',
          topic_catalog_version: 1,
          scope_kind: 'online',
          topics: ['culture'],
          member_cap: 2,
        },
        'different-digest',
        'rotation-key-000001',
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
  });
  it('validates merged scope, unique topics, and atomically clears private description', async () => {
    const owner = account(192);
    await insertAccount(owner);
    const created = await repo.create(
      owner,
      {
        name: 'Scoped',
        description: 'clear-me',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'country',
        country_code: 'US',
        topics: ['culture'],
        member_cap: 2,
      },
      'scoped-create',
      'scoped-key-00000001',
    );
    await expect(
      repo.patch(owner, created.id, { scope_kind: 'city' }, 'bad-scope', 'scoped-key-00000002'),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      repo.patch(
        owner,
        created.id,
        { topics: ['culture', 'culture'] } as any,
        'bad-topics',
        'scoped-key-00000003',
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    const patched = await repo.patch(
      owner,
      created.id,
      { scope_kind: 'online', country_code: null, city_label: null, description: null },
      'clear-scope',
      'scoped-key-00000004',
    );
    expect(patched).toMatchObject({
      scope_kind: 'online',
      country_code: null,
      city_label: null,
      description_available: false,
    });
    await expect(repo.get(owner, created.id)).resolves.toMatchObject({ description: null });
    await expect(
      pool.query('UPDATE circles.circles SET topics=\'["culture","culture"]\'::jsonb WHERE id=$1', [
        created.id,
      ]),
    ).rejects.toThrow();
  });
  it('endpoint-scopes invitation idempotency and persists expired invitation normalization', async () => {
    const owner = account(193),
      first = account(194),
      second = account(195);
    await Promise.all([owner, first, second].map(insertAccount));
    const circle = await repo.create(
      owner,
      {
        name: 'Invitation R2',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 4,
      },
      'invite-r2-create',
      'invite-r2-create-key',
    );
    const firstInvite = await repo.invite(
      owner,
      circle.id,
      { account_id: first, role: 'member' },
      'invite-first',
      'same-invite-key-01',
    );
    await expect(
      repo.invite(
        owner,
        circle.id,
        { account_id: second, role: 'member' },
        'invite-second',
        'same-invite-key-01',
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM circles.invitations WHERE circle_id=$1 AND state='pending'",
          [circle.id],
        )
      ).rows[0].count,
    ).toBe(1);
    await pool.query(
      "UPDATE circles.invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [firstInvite.invitationId],
    );
    await expect(
      repo.respondInvitation(
        first,
        circle.id,
        firstInvite.invitationId,
        'accept',
        'expired-accept',
        'expired-accept-key',
      ),
    ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    expect(
      (
        await pool.query('SELECT state FROM circles.invitations WHERE id=$1', [
          firstInvite.invitationId,
        ])
      ).rows[0].state,
    ).toBe('expired');
    expect(
      (
        await pool.query('SELECT state FROM circles.notification_handoff WHERE invitation_id=$1', [
          firstInvite.invitationId,
        ])
      ).rows[0].state,
    ).toBe('cancelled');
  });
  it('replays completed invitation generations after their deadline but normalizes a pending revoked inviter', async () => {
    const owner = account(205);
    const accepter = account(206);
    const decliner = account(207);
    const expiredInvitee = account(208);
    await Promise.all([owner, accepter, decliner, expiredInvitee].map(insertAccount));
    const circle = await repo.create(
      owner,
      {
        name: 'Terminal invitation expiry',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 5,
      },
      'terminal-expiry-create',
      'terminal-expiry-create-key',
    );
    const accepted = await repo.invite(
      owner,
      circle.id,
      { account_id: accepter, role: 'member' },
      'terminal-expiry-accepted-invite',
      'terminal-expiry-accepted-invite-key',
    );
    const acceptKey = 'terminal-expiry-accept-key';
    await repo.respondInvitation(
      accepter,
      circle.id,
      accepted.invitationId,
      'accept',
      'terminal-expiry-accept',
      acceptKey,
    );
    const declined = await repo.invite(
      owner,
      circle.id,
      { account_id: decliner, role: 'member' },
      'terminal-expiry-declined-invite',
      'terminal-expiry-declined-invite-key',
    );
    const declineKey = 'terminal-expiry-decline-key';
    await repo.respondInvitation(
      decliner,
      circle.id,
      declined.invitationId,
      'decline',
      'terminal-expiry-decline',
      declineKey,
    );
    await pool.query(
      "UPDATE circles.invitations SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",
      [[accepted.invitationId, declined.invitationId]],
    );
    await expect(
      repo.respondInvitation(
        accepter,
        circle.id,
        accepted.invitationId,
        'accept',
        'terminal-expiry-accept',
        acceptKey,
      ),
    ).resolves.toBeUndefined();
    await expect(
      repo.respondInvitation(
        decliner,
        circle.id,
        declined.invitationId,
        'decline',
        'terminal-expiry-decline',
        declineKey,
      ),
    ).resolves.toBeUndefined();
    await expect(
      repo.respondInvitation(
        accepter,
        circle.id,
        accepted.invitationId,
        'accept',
        'terminal-expiry-different-payload',
        acceptKey,
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });

    const pending = await repo.invite(
      owner,
      circle.id,
      { account_id: expiredInvitee, role: 'member' },
      'terminal-expiry-pending-invite',
      'terminal-expiry-pending-invite-key',
    );
    await pool.query(
      "UPDATE circles.invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [pending.invitationId],
    );
    // The pending terminal-state cleanup precedes the inviter authority gate.
    await pool.query(
      "UPDATE circles.memberships SET state='removed' WHERE circle_id=$1 AND account_id=$2",
      [circle.id, owner],
    );
    await expect(
      repo.respondInvitation(
        expiredInvitee,
        circle.id,
        pending.invitationId,
        'accept',
        'terminal-expiry-pending-accept',
        'terminal-expiry-pending-accept-key',
      ),
    ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    expect(
      (
        await pool.query('SELECT state FROM circles.invitations WHERE id=$1', [
          pending.invitationId,
        ])
      ).rows[0].state,
    ).toBe('expired');
  });
  it('binds acceptance to the live inviter and leaves join withdrawal as an escape', async () => {
    const owner = account(197);
    const moderator = account(198);
    const invitee = account(199);
    const applicant = account(200);
    await Promise.all([owner, moderator, invitee, applicant].map(insertAccount));
    const circle = await repo.create(
      owner,
      {
        name: 'Invitation authority',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 5,
      },
      'inviter-live-create',
      'inviter-live-create-key',
    );
    const moderatorInvite = await repo.invite(
      owner,
      circle.id,
      { account_id: moderator, role: 'moderator' },
      'inviter-live-moderator',
      'inviter-live-moderator-key',
    );
    await repo.respondInvitation(
      moderator,
      circle.id,
      moderatorInvite.invitationId,
      'accept',
      'inviter-live-moderator-accept',
      'inviter-live-moderator-accept-key',
    );
    const invite = await repo.invite(
      moderator,
      circle.id,
      { account_id: invitee, role: 'member' },
      'inviter-live-invite',
      'inviter-live-invite-key',
    );
    // A former moderator's generation is not an admission capability.
    await pool.query(
      "UPDATE circles.memberships SET role='member' WHERE circle_id=$1 AND account_id=$2",
      [circle.id, moderator],
    );
    await expect(
      repo.respondInvitation(
        invitee,
        circle.id,
        invite.invitationId,
        'accept',
        'inviter-live-accept',
        'inviter-live-accept-key',
      ),
    ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state='active'",
          [circle.id, invitee],
        )
      ).rows[0].count,
    ).toBe(0);

    await repo.join(applicant, circle.id, {}, 'withdraw-join', 'withdraw-join-key');
    await repo.withdrawJoin(applicant, circle.id, 'withdraw', 'withdraw-key');
    await repo.withdrawJoin(applicant, circle.id, 'withdraw', 'withdraw-key');
    expect(
      (
        await pool.query(
          'SELECT m.state AS membership_state,j.state AS request_state FROM circles.memberships m JOIN circles.join_requests j ON j.circle_id=m.circle_id AND j.account_id=m.account_id WHERE m.circle_id=$1 AND m.account_id=$2',
          [circle.id, applicant],
        )
      ).rows[0],
    ).toMatchObject({ membership_state: 'left', request_state: 'cancelled' });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM circles.audit_events WHERE circle_id=$1 AND actor_account_id=$2 AND event_type='circle.join_withdrawn'",
          [circle.id, applicant],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it('closes both invitation/join admission tracks without leaking a unique-constraint error', async () => {
    const owner = account(201);
    const participant = account(202);
    await Promise.all([owner, participant].map(insertAccount));
    const circle = await repo.create(
      owner,
      {
        name: 'No duplicate admission tracks',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 3,
      },
      'participant-create',
      'participant-create-key',
    );
    const invitation = await repo.invite(
      owner,
      circle.id,
      { account_id: participant, role: 'member' },
      'participant-invite-first',
      'participant-invite-first-key',
    );
    await expect(
      repo.join(
        participant,
        circle.id,
        {},
        'participant-join-after-invite',
        'participant-join-after-invite-key',
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
    await pool.query(
      "INSERT INTO circles.memberships(id,circle_id,account_id,role,state,created_at,updated_at) VALUES($1,$2,$3,'member','pending',now(),now())",
      [randomUUID(), circle.id, participant],
    );
    await expect(
      repo.respondInvitation(
        participant,
        circle.id,
        invitation.invitationId,
        'accept',
        'participant-pending-accept',
        'participant-pending-accept-key',
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
    await pool.query(
      "UPDATE circles.memberships SET state='active' WHERE circle_id=$1 AND account_id=$2",
      [circle.id, participant],
    );
    await expect(
      repo.respondInvitation(
        participant,
        circle.id,
        invitation.invitationId,
        'accept',
        'participant-active-accept',
        'participant-active-accept-key',
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
  });
  it('rechecks current acceptance authority before an exact idempotency replay', async () => {
    const owner = account(203);
    const invitee = account(204);
    await Promise.all([owner, invitee].map(insertAccount));
    const circle = await repo.create(
      owner,
      {
        name: 'Replay authority',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 3,
      },
      'replay-authority-create',
      'replay-authority-create-key',
    );
    const invitation = await repo.invite(
      owner,
      circle.id,
      { account_id: invitee, role: 'member' },
      'replay-authority-invite',
      'replay-authority-invite-key',
    );
    let allowed = true;
    const gated = new PgCircleRepository(pool, new Map([['test-key', key]]), 'test-key', {
      check: async () => ({ allowed }),
    });
    const acceptKey = 'replay-authority-accept-key';
    await gated.respondInvitation(
      invitee,
      circle.id,
      invitation.invitationId,
      'accept',
      'replay-authority-accept',
      acceptKey,
    );
    await expect(
      repo.invite(
        owner,
        circle.id,
        { account_id: invitee, role: 'member' },
        'replay-authority-invite',
        'replay-authority-invite-key',
      ),
    ).resolves.toMatchObject({ invitationId: invitation.invitationId });
    allowed = false;
    await expect(
      gated.respondInvitation(
        invitee,
        circle.id,
        invitation.invitationId,
        'accept',
        'replay-authority-accept',
        acceptKey,
      ),
    ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });
  it('bounds a former member note report to content visible before removal', async () => {
    const owner = account(212);
    const formerMember = account(213);
    await Promise.all([owner, formerMember].map(insertAccount));
    const circle = await repo.create(
      owner,
      {
        name: 'Historical reporting boundary',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 3,
      },
      'historical-report-create',
      'historical-report-create-key',
    );
    const invitation = await repo.invite(
      owner,
      circle.id,
      { account_id: formerMember, role: 'member' },
      'historical-report-invite',
      'historical-report-invite-key',
    );
    await repo.respondInvitation(
      formerMember,
      circle.id,
      invitation.invitationId,
      'accept',
      'historical-report-accept',
      'historical-report-accept-key',
    );
    const visibleBeforeRemoval = await repo.addNote(
      owner,
      circle.id,
      'visible before removal',
      'historical-report-before',
      'historical-report-before-key',
    );
    await repo.memberAction(
      owner,
      circle.id,
      formerMember,
      'remove',
      undefined,
      'historical-report-remove',
      'historical-report-remove-key',
    );
    const futureNote = await repo.addNote(
      owner,
      circle.id,
      'not visible after removal',
      'historical-report-after',
      'historical-report-after-key',
    );
    await expect(
      repo.reportableEvidence(formerMember, 'note', visibleBeforeRemoval.id, circle.id),
    ).resolves.toMatchObject({ subjectAccountId: owner });
    await expect(
      repo.reportableEvidence(formerMember, 'note', futureNote.id, circle.id),
    ).resolves.toBeNull();
  });
  it('rejects forged erasure markers while allowing only real IAM FK erasure', async () => {
    const owner = account(196);
    const actorOnly = account(209);
    const subjectOnly = account(210);
    const both = account(211);
    await insertAccount(owner);
    await Promise.all([actorOnly, subjectOnly, both].map(insertAccount));
    const created = await repo.create(
      owner,
      {
        name: 'Erasure guard',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 2,
      },
      'erasure-create',
      'erasure-key-00000001',
    );
    const note = await repo.addNote(
      owner,
      created.id,
      'guarded',
      'erasure-note',
      'erasure-key-00000002',
    );
    const forge = async (sql: string, values: string[]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('circles.erasure_account',$1,true)", [owner]);
        await client.query(sql, values);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    await expect(
      forge('DELETE FROM circles.audit_events WHERE circle_id=$1', [created.id]),
    ).rejects.toThrow();
    await expect(forge('DELETE FROM circles.notes WHERE id=$1', [note.id])).rejects.toThrow();
    await expect(
      forge('UPDATE circles.audit_events SET actor_account_id=NULL WHERE circle_id=$1', [
        created.id,
      ]),
    ).rejects.toThrow();
    const actorEvent = (
      await pool.query<{ id: number }>(
        "INSERT INTO circles.audit_events(circle_id,actor_account_id,subject_account_id,event_type,metadata,created_at) VALUES($1,$2,NULL,'circle.created','{}',now()) RETURNING id",
        [created.id, actorOnly],
      )
    ).rows[0]!.id;
    const subjectEvent = (
      await pool.query<{ id: number }>(
        "INSERT INTO circles.audit_events(circle_id,actor_account_id,subject_account_id,event_type,metadata,created_at) VALUES($1,$2,$3,'circle.created','{}',now()) RETURNING id",
        [created.id, owner, subjectOnly],
      )
    ).rows[0]!.id;
    const bothEvent = (
      await pool.query<{ id: number }>(
        "INSERT INTO circles.audit_events(circle_id,actor_account_id,subject_account_id,event_type,metadata,created_at) VALUES($1,$2,$2,'circle.created','{}',now()) RETURNING id",
        [created.id, both],
      )
    ).rows[0]!.id;
    await expect(
      pool.query('UPDATE circles.audit_events SET subject_account_id=NULL WHERE id=$1', [
        subjectEvent,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM iam.accounts WHERE id=$1', [actorOnly]),
    ).resolves.toBeDefined();
    await expect(
      pool.query('DELETE FROM iam.accounts WHERE id=$1', [subjectOnly]),
    ).resolves.toBeDefined();
    await expect(pool.query('DELETE FROM iam.accounts WHERE id=$1', [both])).resolves.toBeDefined();
    expect(
      (
        await pool.query(
          'SELECT id,actor_account_id,subject_account_id FROM circles.audit_events WHERE id=ANY($1::bigint[]) ORDER BY id',
          [[actorEvent, subjectEvent, bothEvent]],
        )
      ).rows,
    ).toEqual([
      { id: actorEvent, actor_account_id: null, subject_account_id: null },
      { id: subjectEvent, actor_account_id: owner, subject_account_id: null },
      { id: bothEvent, actor_account_id: null, subject_account_id: null },
    ]);
    await expect(forge('DELETE FROM circles.circles WHERE id=$1', [created.id])).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM iam.accounts WHERE id=$1', [owner]),
    ).resolves.toBeDefined();
    expect(
      (await pool.query('SELECT 1 FROM circles.circles WHERE id=$1', [created.id])).rowCount,
    ).toBe(0);
  });
  it('keeps Unicode private canaries out of all durable circle surfaces', async () => {
    const owner = account(91);
    const applicant = account(92);
    await insertAccount(owner);
    await insertAccount(applicant);
    const canary = '私密🔐\u2063circle-canary';
    const created = await repo.create(
      owner,
      {
        name: 'Canary',
        description: canary,
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 2,
      },
      'canary-create',
      'canary-key-00000001',
    );
    await repo.addNote(owner, created.id, canary, 'canary-note', 'canary-key-00000002');
    await repo.join(
      applicant,
      created.id,
      { message: canary },
      'canary-join',
      'canary-key-00000003',
    );
    const persisted = await pool.query(
      `SELECT string_agg(value, E'\\n') AS text FROM (
        SELECT row_to_json(c)::text AS value FROM circles.circles c
        UNION ALL SELECT row_to_json(n)::text FROM circles.notes n
        UNION ALL SELECT row_to_json(j)::text FROM circles.join_requests j
        UNION ALL SELECT row_to_json(i)::text FROM circles.idempotency i
        UNION ALL SELECT row_to_json(a)::text FROM circles.audit_events a
        UNION ALL SELECT row_to_json(h)::text FROM circles.notification_handoff h
      ) all_circle_rows`,
    );
    expect(persisted.rows[0].text).not.toContain(canary);
  });
  it('serializes the final cap admission and cascades erasure', async () => {
    const owner = account(2);
    const contenders = Array.from({ length: 20 }, (_, offset) => account(offset + 3));
    await insertAccount(owner);
    await Promise.all(contenders.map(insertAccount));
    const circle = await repo.create(
      owner,
      {
        name: 'Capped',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 5,
      },
      'create-digest-2',
      'create-key-00000002',
    );
    await Promise.all(
      contenders.map((contender, index) =>
        repo.join(
          contender,
          circle.id,
          {},
          `join-digest-cap-${index}`,
          `join-key-cap-${String(index).padStart(8, '0')}`,
        ),
      ),
    );
    const race = await Promise.allSettled([
      ...contenders.map((contender, index) =>
        repo.memberAction(
          owner,
          circle.id,
          contender,
          'approve',
          undefined,
          `approve-digest-cap-${index}`,
          `approve-key-cap-${String(index).padStart(8, '0')}`,
        ),
      ),
    ]);
    expect(race.filter((x) => x.status === 'fulfilled')).toHaveLength(4);
    expect(race.filter((x) => x.status === 'rejected')).toHaveLength(16);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM circles.memberships WHERE circle_id=$1 AND state='active'",
          [circle.id],
        )
      ).rows[0].count,
    ).toBe(5);
    await pool.query('DELETE FROM iam.accounts WHERE id=$1', [owner]);
    expect(
      (
        await pool.query('SELECT count(*)::int AS count FROM circles.circles WHERE id=$1', [
          circle.id,
        ])
      ).rows[0].count,
    ).toBe(0);
  });
  it('replays identical idempotency and rejects a conflicting payload', async () => {
    const owner = account(93);
    await insertAccount(owner);
    const input: Parameters<PgCircleRepository['create']>[1] = {
      name: 'Idempotent',
      lifecycle: 'active',
      visibility: 'approval_required',
      mode: 'friends',
      topic_catalog_version: 1,
      scope_kind: 'online',
      topics: ['culture'],
      member_cap: 2,
    };
    const first = await repo.create(owner, input, 'same-payload', 'same-key-000000001');
    const replay = await repo.create(owner, input, 'same-payload', 'same-key-000000001');
    expect(replay.id).toBe(first.id);
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () =>
        repo.create(owner, input, 'same-payload', 'same-key-000000001'),
      ),
    );
    expect(new Set(concurrent.map((circle) => circle.id))).toEqual(new Set([first.id]));
    await expect(
      repo.create(
        owner,
        { ...input, name: 'Different' },
        'different-payload',
        'same-key-000000001',
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
  });
  it('protects the last owner until an explicit owner transfer', async () => {
    const owner = account(94),
      member = account(95);
    await insertAccount(owner);
    await insertAccount(member);
    const created = await repo.create(
      owner,
      {
        name: 'Owners',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 3,
      },
      'owners-create',
      'owners-key-00000001',
    );
    await expect(
      repo.leave(owner, created.id, 'owners-leave', 'owners-key-00000002'),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
    const invitation = await repo.invite(
      owner,
      created.id,
      { account_id: member, role: 'member' },
      'owners-invite',
      'owners-key-00000003',
    );
    await repo.respondInvitation(
      member,
      created.id,
      invitation.invitationId,
      'accept',
      'owners-accept',
      'owners-key-00000004',
    );
    await repo.memberAction(
      owner,
      created.id,
      member,
      'role',
      'owner',
      'owners-transfer',
      'owners-key-00000005',
    );
    await expect(
      repo.leave(owner, created.id, 'owners-leave-2', 'owners-key-00000006'),
    ).resolves.toBeUndefined();
  });
  it('cancels an invitation generation and its opaque handoff atomically', async () => {
    const owner = account(96);
    const invitee = account(97);
    await insertAccount(owner);
    await insertAccount(invitee);
    const created = await repo.create(
      owner,
      {
        name: 'Cancel invitation',
        lifecycle: 'active',
        visibility: 'invitation_only',
        mode: 'friends',
        topic_catalog_version: 1,
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 3,
      },
      'cancel-create',
      'cancel-key-00000001',
    );
    const invited = await repo.invite(
      owner,
      created.id,
      { account_id: invitee, role: 'member' },
      'cancel-invite',
      'cancel-key-00000002',
    );
    await repo.cancelInvitation(
      owner,
      created.id,
      invited.invitationId,
      'cancel-invitation',
      'cancel-key-00000003',
    );
    await expect(
      pool.query(
        'SELECT i.state AS invitation_state,h.state AS handoff_state,h.last_error FROM circles.invitations i JOIN circles.notification_handoff h ON h.invitation_id=i.id WHERE i.id=$1',
        [invited.invitationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          invitation_state: 'cancelled',
          handoff_state: 'cancelled',
          last_error: 'INVITATION_CANCELLED',
        },
      ],
    });
  });
});
