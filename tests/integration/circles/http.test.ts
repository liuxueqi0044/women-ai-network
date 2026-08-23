import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv, type AppConfig } from '@wai/config';
import { createPool, MigrationRunner } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import { valkeyUrl } from '../helpers.js';

declare const WAI_MIGRATIONS_DIR: string;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (label: string) => `cir-http-${label}-${randomUUID()}`;
const origin = 'http://localhost:3000';

let started: StartedInfra;
let config: AppConfig;
let pool: Pool;
let app: Awaited<ReturnType<typeof createApiApp>>;
let baseUrl: string;
let jurisdictionPolicyId: string;
let membershipPolicyId: string;
let jurisdictionPolicyHash: string;
let fixtureNumber = 0;

type Session = { accountId: string; cookie: string };

function port(api: Awaited<ReturnType<typeof createApiApp>>): number {
  const address = (api.getHttpServer() as Server).address();
  if (address === null || typeof address === 'string') throw new Error('API did not bind');
  return address.port;
}

async function request(session: Session | undefined, path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(session === undefined ? {} : { cookie: session.cookie }),
      ...(init.headers ?? {}),
    },
  });
}

async function json(
  session: Session | undefined,
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  idempotencyKey = key('mutation'),
  requestOrigin = origin,
) {
  return request(session, path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(requestOrigin === '' ? {} : { origin: requestOrigin }),
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function registerAndLogin(label: string): Promise<Session> {
  const email = `cir-http-${label}-${randomUUID()}@example.invalid`;
  const password = 'correct horse battery staple';
  const registration = await json(
    undefined,
    '/v1/account/registrations',
    'POST',
    { email, password },
    key('registration'),
    '',
  );
  expect(registration.status).toBe(201);
  const registrationBody = (await registration.json()) as { account_id: string };
  const login = await json(
    undefined,
    '/v1/account/sessions',
    'POST',
    { email, password },
    key('login'),
    '',
  );
  expect(login.status).toBe(201);
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith('wai_session_dev='))
    ?.split(';')[0];
  if (!cookie) throw new Error('real login did not return a session cookie');
  return { accountId: registrationBody.account_id, cookie };
}

/** Real external authority facts; requests still traverse the production session guard and gate. */
async function seedAuthority(sessions: readonly Session[]): Promise<void> {
  const now = new Date();
  jurisdictionPolicyId = randomUUID();
  membershipPolicyId = randomUUID();
  jurisdictionPolicyHash = sha(`circles-policy:${jurisdictionPolicyId}`);
  fixtureNumber += 1;
  const jurisdictionKey = `US-${fixtureNumber}`;
  const policyClient = await pool.connect();
  try {
    await policyClient.query('BEGIN');
    await policyClient.query(`SELECT set_config('app.eligibility_policy_publish','true',true)`);
    await policyClient.query(
      `INSERT INTO eligibility.jurisdiction_policies
         (id,jurisdiction_key,revision,status,content,content_hash,rule_hash,location_precision_policy,profiling_policy,retention_policy,legal_basis_refs,reviewed_by,reviewed_at,timezone,effective_from,effective_until,created_at)
       VALUES ($1,$2,1,'approved','{}',$3,$3,'country_only','derived_facts_only','test',ARRAY['test:cir'],'principal',$4,'UTC',$4,'infinity',$4)`,
      [jurisdictionPolicyId, jurisdictionKey, jurisdictionPolicyHash, now],
    );
    await policyClient.query('COMMIT');
  } catch (error) {
    await policyClient.query('ROLLBACK');
    throw error;
  } finally {
    policyClient.release();
  }
  const membershipHash = sha(`membership:${membershipPolicyId}`);
  await pool.query(
    `INSERT INTO verification.membership_policies(id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,effective_from,effective_until,created_at)
     VALUES ($1,1,'approved',$2,'test:cir','principal',$3,$3,'infinity',$3)`,
    [membershipPolicyId, membershipHash, now],
  );
  for (const session of sessions) {
    const identityId = randomUUID();
    const evidenceId = randomUUID();
    const credentialId = randomUUID();
    await pool.query(
      `INSERT INTO verification.identity_cases(id,account_id,state,age_assurance_state,version,created_at,updated_at,verified_at)
       VALUES ($1,$2,'verified','attested',1,$3,$3,$3)`,
      [identityId, session.accountId, now],
    );
    await pool.query(
      `INSERT INTO eligibility.age_evidence(id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,created_at,verification_case_id,external_attestation_digest)
       VALUES ($1,$2,$3,'cipher','nonce','key','verification_provider',$4,$4,$5,$6)`,
      [
        evidenceId,
        session.accountId,
        sha(`birthday:${session.accountId}`),
        now,
        identityId,
        sha(`attestation:${session.accountId}`),
      ],
    );
    await pool.query(
      `INSERT INTO eligibility.age_credentials(id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,policy_revision,valid_from,valid_until,derived_at,derivation_version,created_at)
       VALUES ($1,$2,'adult','adult','externally_attested','verification_module',$3,$4,1,$5,'infinity',$5,1,$5)`,
      [credentialId, session.accountId, evidenceId, jurisdictionPolicyId, now],
    );
    await pool.query(
      `INSERT INTO verification.membership_cases(id,account_id,policy_id,policy_revision,policy_content_hash,statement_category,consented_at,state,version,decided_at,created_at,updated_at)
       VALUES ($1,$2,$3,1,$4,'community_participation',$5,'approved',1,$5,$5,$5)`,
      [randomUUID(), session.accountId, membershipPolicyId, membershipHash, now],
    );
    await insertModeDecision(session.accountId, credentialId, 'circles', 'allow');
    await insertModeDecision(session.accountId, credentialId, 'friends', 'allow');
  }
  for (const actor of sessions) {
    for (const subject of sessions) {
      if (actor.accountId !== subject.accountId)
        await insertPartition(actor.accountId, subject.accountId, 'allow');
    }
  }
}

async function credentialFor(accountId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM eligibility.age_credentials WHERE account_id=$1 AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [accountId],
  );
  const credential = result.rows[0]?.id;
  if (!credential) throw new Error('fixture credential missing');
  return credential;
}

async function insertModeDecision(
  accountId: string,
  credentialId: string,
  mode: 'circles' | 'friends',
  decision: 'allow' | 'deny',
): Promise<void> {
  await pool.query(
    `INSERT INTO eligibility.mode_decisions(decision_id,account_id,scope,mode,decision,age_band,cohort_key,assurance_level,reason_codes,policy_id,policy_revision,policy_hash,credential_id,credential_hash,input_hash,evaluated_at,valid_until,engine_version,created_at)
     VALUES ($1,$2,'age_and_jurisdiction',$3,$4,'adult','adult','externally_attested',CASE WHEN $4='allow' THEN '{}'::text[] ELSE ARRAY['MODE_DISABLED'] END,$5,1,$6,$7,$8,$9,now(),'infinity',1,now())`,
    [
      randomUUID(),
      accountId,
      mode,
      decision,
      jurisdictionPolicyId,
      jurisdictionPolicyHash,
      credentialId,
      sha(`credential:${credentialId}`),
      sha(`mode:${accountId}:${mode}:${decision}:${randomUUID()}`),
    ],
  );
}

async function insertPartition(
  actorAccountId: string,
  subjectAccountId: string,
  decision: 'allow' | 'deny',
) {
  await pool.query(
    `INSERT INTO eligibility.partition_decisions(decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
     VALUES ($1,$2,$3,'adult','adult','adult','adult','circles',$4,CASE WHEN $4='allow' THEN '{}'::text[] ELSE ARRAY['MODE_DISABLED'] END,$5,$5,1,1,$6,$6,$7,now(),1,now())`,
    [
      randomUUID(),
      actorAccountId,
      subjectAccountId,
      decision,
      jurisdictionPolicyId,
      jurisdictionPolicyHash,
      sha(`partition:${actorAccountId}:${subjectAccountId}:${decision}:${randomUUID()}`),
    ],
  );
}

async function createCircle(owner: Session, name = 'Circle HTTP'): Promise<string> {
  const response = await json(owner, '/v1/circles', 'POST', {
    name,
    description: 'private test description',
    lifecycle: 'active',
    visibility: 'approval_required',
    mode: 'friends',
    scope_kind: 'online',
    topics: ['culture'],
    member_cap: 5,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

beforeAll(async () => {
  started = await startTestInfra();
  config = loadEnv({
    NODE_ENV: 'test',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'warn',
    DATABASE_URL: started.infra.databaseUrl,
    VALKEY_URL: valkeyUrl(started.infra),
  });
  pool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  app = await createApiApp(config);
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${port(app)}`;
}, 180_000);

afterAll(async () => {
  await closeApiApp(app);
  await pool.end();
  await started.stop();
});

describe('CIR-01 production HTTP authority boundary', () => {
  it('uses real account sessions and authoritative current IAM/VER/ELG facts for the lifecycle', async () => {
    const [owner, invitee, decliner, applicant, rejectedApplicant] = (await Promise.all(
      ['owner', 'invitee', 'decliner', 'applicant', 'rejected'].map(registerAndLogin),
    )) as [Session, Session, Session, Session, Session];
    await seedAuthority([owner, invitee, decliner, applicant, rejectedApplicant]);
    const circleId = await createCircle(owner, 'Lifecycle circle');
    expect(
      (await json(owner, `/v1/circles/${circleId}`, 'PATCH', { name: 'Renamed circle' })).status,
    ).toBe(200);

    const invitationKey = key('lifecycle-invite');
    const invitation = await json(
      owner,
      `/v1/circles/${circleId}/invitations`,
      'POST',
      { account_id: invitee.accountId, role: 'member' },
      invitationKey,
    );
    expect(invitation.status).toBe(201);
    const { invitation_id: invitationId } = (await invitation.json()) as { invitation_id: string };
    expect(invitationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (
        await json(
          invitee,
          `/v1/circles/${circleId}/invitations/${invitationId}/accept`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);
    const inviteReplay = await json(
      owner,
      `/v1/circles/${circleId}/invitations`,
      'POST',
      { account_id: invitee.accountId, role: 'member' },
      invitationKey,
    );
    expect(inviteReplay.status).toBe(201);
    expect((await inviteReplay.json()) as { invitation_id: string }).toMatchObject({
      invitation_id: invitationId,
    });

    const decliningInvitation = await json(owner, `/v1/circles/${circleId}/invitations`, 'POST', {
      account_id: decliner.accountId,
      role: 'member',
    });
    const { invitation_id: declineInvitationId } = (await decliningInvitation.json()) as {
      invitation_id: string;
    };
    expect((await json(decliner, `/v1/circles/${circleId}/join-requests`, 'POST', {})).status).toBe(
      409,
    );
    expect(
      (
        await json(
          decliner,
          `/v1/circles/${circleId}/invitations/${declineInvitationId}/decline`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);

    expect(
      (
        await json(applicant, `/v1/circles/${circleId}/join-requests`, 'POST', {
          message: 'I would like to take part.',
        })
      ).status,
    ).toBe(201);
    const detail = await request(owner, `/v1/circles/${circleId}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()) as { description: string }).toMatchObject({
      description: 'private test description',
    });
    const pendingRequests = await request(owner, `/v1/circles/${circleId}/join-requests?limit=10`);
    expect(pendingRequests.status).toBe(200);
    expect(
      (await pendingRequests.json()) as { items: Array<{ account_id: string; message: string }> },
    ).toMatchObject({
      items: [
        expect.objectContaining({
          account_id: applicant.accountId,
          message: 'I would like to take part.',
        }),
      ],
    });
    expect(
      (
        await json(
          owner,
          `/v1/circles/${circleId}/members/${applicant.accountId}/approve`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);
    expect(
      (await json(rejectedApplicant, `/v1/circles/${circleId}/join-requests`, 'POST', {})).status,
    ).toBe(201);
    expect(
      (
        await json(
          owner,
          `/v1/circles/${circleId}/members/${rejectedApplicant.accountId}/decline`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);

    const note = await json(invitee, `/v1/circles/${circleId}/notes`, 'POST', {
      body: 'An encrypted note.',
    });
    expect(note.status).toBe(201);
    const notes = await request(owner, `/v1/circles/${circleId}/notes?limit=10`);
    expect(notes.status).toBe(200);
    expect(((await notes.json()) as { items: Array<{ body: string }> }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: 'An encrypted note.' })]),
    );
    const members = await request(owner, `/v1/circles/${circleId}/members?limit=10`);
    expect(members.status).toBe(200);
    expect(((await members.json()) as { items: Array<{ account_id: string }> }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ account_id: invitee.accountId })]),
    );

    expect(
      (
        await json(owner, `/v1/circles/${circleId}/members/${invitee.accountId}/role`, 'POST', {
          role: 'owner',
        })
      ).status,
    ).toBe(201);
    expect((await json(owner, `/v1/circles/${circleId}/leave`, 'POST', {})).status).toBe(201);
    expect(
      (
        await json(
          invitee,
          `/v1/circles/${circleId}/members/${applicant.accountId}/remove`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);
  }, 90_000);

  it('enforces Origin, strict validation, opaque IDOR and payload-bound idempotency over HTTP', async () => {
    const [owner, stranger] = (await Promise.all([
      registerAndLogin('security-owner'),
      registerAndLogin('security-stranger'),
    ])) as [Session, Session];
    await seedAuthority([owner, stranger]);
    const rejectedOrigin = await json(
      owner,
      '/v1/circles',
      'POST',
      {
        name: 'Rejected origin',
        lifecycle: 'active',
        visibility: 'approval_required',
        mode: 'friends',
        scope_kind: 'online',
        topics: ['culture'],
        member_cap: 2,
      },
      key('origin'),
      'https://evil.example',
    );
    expect(rejectedOrigin.status).toBe(403);
    const strict = await json(owner, '/v1/circles', 'POST', {
      name: 'Strict',
      lifecycle: 'active',
      visibility: 'approval_required',
      mode: 'friends',
      scope_kind: 'online',
      topics: ['culture'],
      member_cap: 2,
      owner_account_id: stranger.accountId,
    });
    expect(strict.status).toBe(400);
    const archivedCreate = await json(owner, '/v1/circles', 'POST', {
      name: 'Never created archived',
      lifecycle: 'archived',
      visibility: 'approval_required',
      mode: 'friends',
      scope_kind: 'online',
      topics: ['culture'],
      member_cap: 2,
    });
    expect(archivedCreate.status).toBe(400);
    const payload = {
      name: 'Idempotent HTTP',
      lifecycle: 'active',
      visibility: 'approval_required',
      mode: 'friends',
      scope_kind: 'online',
      topics: ['culture'],
      member_cap: 3,
    };
    const idem = key('same');
    const first = await json(owner, '/v1/circles', 'POST', payload, idem);
    const firstBody = (await first.json()) as { id: string };
    const replay = await json(owner, '/v1/circles', 'POST', payload, idem);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { id: string }).id).toBe(firstBody.id);
    const conflict = await json(
      owner,
      '/v1/circles',
      'POST',
      { ...payload, name: 'Different' },
      idem,
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe('CIRCLE_CONFLICT');
    expect((await request(stranger, `/v1/circles/${firstBody.id}`)).status).toBe(404);
    expect((await request(owner, '/v1/circles/not-a-uuid')).status).toBe(400);
    expect(
      (
        await json(
          owner,
          `/v1/circles/${firstBody.id}/members/${stranger.accountId}/nonsense`,
          'POST',
          {},
        )
      ).status,
    ).toBe(400);
    const archiveKey = key('archive-replay');
    const archived = await json(
      owner,
      `/v1/circles/${firstBody.id}`,
      'PATCH',
      { lifecycle: 'archived' },
      archiveKey,
    );
    expect(archived.status).toBe(200);
    expect((await archived.json()) as { lifecycle: string }).toMatchObject({
      lifecycle: 'archived',
    });
    const archiveReplay = await json(
      owner,
      `/v1/circles/${firstBody.id}`,
      'PATCH',
      { lifecycle: 'archived' },
      archiveKey,
    );
    expect(archiveReplay.status).toBe(200);
    expect((await archiveReplay.json()) as { lifecycle: string }).toMatchObject({
      lifecycle: 'archived',
    });
    expect(
      (await json(owner, `/v1/circles/${firstBody.id}`, 'PATCH', { name: 'conflict' }, archiveKey))
        .status,
    ).toBe(409);
    expect((await request(owner, `/v1/circles/${firstBody.id}`)).status).toBe(404);
    expect(
      (await json(owner, `/v1/circles/${firstBody.id}/notes`, 'POST', { body: 'closed' })).status,
    ).toBe(404);
    expect(
      (await json(owner, `/v1/circles/${firstBody.id}`, 'PATCH', { lifecycle: 'active' })).status,
    ).toBe(404);
  }, 90_000);

  it('returns stable 409 for capacity and last-owner conflicts, and 429 from the real Valkey limiter', async () => {
    const [owner, admitted, overflow, rateActor] = (await Promise.all(
      ['cap-owner', 'cap-admitted', 'cap-overflow', 'rate-actor'].map(registerAndLogin),
    )) as [Session, Session, Session, Session];
    await seedAuthority([owner, admitted, overflow, rateActor]);
    const created = await json(owner, '/v1/circles', 'POST', {
      name: 'Capacity boundary',
      lifecycle: 'active',
      visibility: 'approval_required',
      mode: 'friends',
      scope_kind: 'online',
      topics: ['culture'],
      member_cap: 2,
    });
    expect(created.status).toBe(201);
    const { id: circleId } = (await created.json()) as { id: string };
    const invite = await json(owner, `/v1/circles/${circleId}/invitations`, 'POST', {
      account_id: admitted.accountId,
      role: 'member',
    });
    const { invitation_id: admittedInvitation } = (await invite.json()) as {
      invitation_id: string;
    };
    expect(
      (
        await json(
          admitted,
          `/v1/circles/${circleId}/invitations/${admittedInvitation}/accept`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);
    const lastOwner = await json(owner, `/v1/circles/${circleId}/leave`, 'POST', {});
    expect(lastOwner.status).toBe(409);
    expect(((await lastOwner.json()) as { code: string }).code).toBe('CIRCLE_CONFLICT');
    const overflowInvite = await json(owner, `/v1/circles/${circleId}/invitations`, 'POST', {
      account_id: overflow.accountId,
      role: 'member',
    });
    const { invitation_id: overflowInvitation } = (await overflowInvite.json()) as {
      invitation_id: string;
    };
    const cap = await json(
      overflow,
      `/v1/circles/${circleId}/invitations/${overflowInvitation}/accept`,
      'POST',
      {},
    );
    expect(cap.status).toBe(409);
    expect(((await cap.json()) as { code: string }).code).toBe('CIRCLE_CONFLICT');

    const ratePayload = {
      lifecycle: 'active',
      visibility: 'approval_required',
      mode: 'friends',
      scope_kind: 'online',
      topics: ['culture'],
      member_cap: 2,
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await json(rateActor, '/v1/circles', 'POST', {
        ...ratePayload,
        name: `Rate ${index}`,
      });
      expect(response.status).toBe(201);
    }
    const limited = await json(rateActor, '/v1/circles', 'POST', {
      ...ratePayload,
      name: 'Rate limited',
    });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe('RATE_LIMITED');
  }, 180_000);

  it('fails closed after revocation while leave and invitation decline remain safe escapes', async () => {
    const [owner, member, pendingInvitee] = (await Promise.all(
      ['revoke-owner', 'revoke-member', 'revoke-invitee'].map(registerAndLogin),
    )) as [Session, Session, Session];
    await seedAuthority([owner, member, pendingInvitee]);
    const circleId = await createCircle(owner, 'Revocation circle');
    const invite = await json(owner, `/v1/circles/${circleId}/invitations`, 'POST', {
      account_id: member.accountId,
      role: 'member',
    });
    const memberInvitation = (await invite.json()) as { invitation_id: string };
    expect(
      (
        await json(
          member,
          `/v1/circles/${circleId}/invitations/${memberInvitation.invitation_id}/accept`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);
    const pending = await json(owner, `/v1/circles/${circleId}/invitations`, 'POST', {
      account_id: pendingInvitee.accountId,
      role: 'member',
    });
    const pendingInvitation = (await pending.json()) as { invitation_id: string };
    // A policy/eligibility revocation cannot strand an otherwise authenticated
    // member. Ordinary access closes, but the resource-bound escape succeeds.
    await insertModeDecision(
      member.accountId,
      await credentialFor(member.accountId),
      'circles',
      'deny',
    );
    expect((await request(member, `/v1/circles/${circleId}`)).status).toBe(404);
    expect((await json(member, `/v1/circles/${circleId}/leave`, 'POST', {})).status).toBe(201);
    // After leaving, the same account can become a pending applicant. It must
    // still be able to self-withdraw after a new policy revocation.
    await insertModeDecision(
      member.accountId,
      await credentialFor(member.accountId),
      'circles',
      'allow',
    );
    expect(
      (
        await json(member, `/v1/circles/${circleId}/join-requests`, 'POST', {
          message: 'withdrawable pending request',
        })
      ).status,
    ).toBe(201);
    await insertModeDecision(
      member.accountId,
      await credentialFor(member.accountId),
      'circles',
      'deny',
    );
    const withdrawKey = key('withdraw');
    expect(
      (
        await json(
          member,
          `/v1/circles/${circleId}/join-requests/withdraw`,
          'POST',
          {},
          withdrawKey,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await json(
          member,
          `/v1/circles/${circleId}/join-requests/withdraw`,
          'POST',
          {},
          withdrawKey,
        )
      ).status,
    ).toBe(201);
    await pool.query(
      "UPDATE iam.accounts SET state='suspended',state_reason='admin_suspend' WHERE id=$1",
      [member.accountId],
    );
    expect((await request(member, `/v1/circles/${circleId}`)).status).toBe(401);

    for (const kind of [
      'identity',
      'membership',
      'circles',
      'friends',
      'partition',
      'block',
      'action',
    ] as const) {
      const [actor, subject] = await Promise.all([
        registerAndLogin(`deny-${kind}-a`),
        registerAndLogin(`deny-${kind}-b`),
      ]);
      await seedAuthority([actor, subject]);
      const targetCircle = await createCircle(actor, `Deny ${kind}`);
      if (kind === 'identity') {
        await pool.query(
          "UPDATE verification.identity_cases SET state='failed',age_assurance_state='revoked',updated_at=now() WHERE account_id=$1",
          [actor.accountId],
        );
      } else if (kind === 'membership') {
        await pool.query(
          "UPDATE verification.membership_cases SET state='withdrawn',updated_at=now() WHERE account_id=$1",
          [actor.accountId],
        );
      } else if (kind === 'circles' || kind === 'friends') {
        await insertModeDecision(
          actor.accountId,
          await credentialFor(actor.accountId),
          kind,
          'deny',
        );
      } else if (kind === 'partition') {
        await insertPartition(actor.accountId, subject.accountId, 'deny');
        expect(
          (
            await json(actor, `/v1/circles/${targetCircle}/invitations`, 'POST', {
              account_id: subject.accountId,
              role: 'member',
            })
          ).status,
        ).toBe(404);
        continue;
      } else if (kind === 'block') {
        await pool.query(
          `INSERT INTO safety.blocks(id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at) VALUES($1,$2,$3,'unwanted_contact',$4,$5,'active',now())`,
          [
            randomUUID(),
            actor.accountId,
            subject.accountId,
            sha(`block:${randomUUID()}`),
            sha(`request:${randomUUID()}`),
          ],
        );
        expect(
          (
            await json(actor, `/v1/circles/${targetCircle}/invitations`, 'POST', {
              account_id: subject.accountId,
              role: 'member',
            })
          ).status,
        ).toBe(404);
        continue;
      } else {
        const reportId = randomUUID();
        await pool.query(
          `INSERT INTO safety.reports(id,reporter_account_id,subject_account_id,target_type,target_id,category,idempotency_digest,request_digest,state,created_at,updated_at) VALUES($1,$2,$3,'account',$4,'other',$5,$6,'open',now(),now())`,
          [
            reportId,
            subject.accountId,
            actor.accountId,
            actor.accountId,
            sha(`report:${randomUUID()}`),
            sha(`request:${randomUUID()}`),
          ],
        );
        const caseId = randomUUID();
        await pool.query(
          `INSERT INTO safety.cases(id,report_id,severity,queue,state,version,created_at,updated_at) VALUES($1,$2,'high','cir-test','open',0,now(),now())`,
          [caseId, reportId],
        );
        await pool.query(
          `INSERT INTO safety.actions(id,case_id,action_type,state,proposer_id,approver_id,reason_code,effective_from,execution_token,executed_at,created_at,updated_at) VALUES($1,$2,'temporary_restriction','executed','moderator','approver','POLICY_VIOLATION_CONFIRMED',now(),$3,now(),now(),now())`,
          [randomUUID(), caseId, randomUUID()],
        );
      }
      expect((await request(actor, `/v1/circles/${targetCircle}`)).status).toBe(404);
      expect(
        (await json(actor, `/v1/circles/${targetCircle}/notes`, 'POST', { body: 'blocked' }))
          .status,
      ).toBe(404);
    }
    expect(
      (
        await json(
          pendingInvitee,
          `/v1/circles/${circleId}/invitations/${pendingInvitation.invitation_id}/decline`,
          'POST',
          {},
        )
      ).status,
    ).toBe(201);
  }, 180_000);

  it('keeps an historical member reportable after policy revocation without copying note text to SAF', async () => {
    const [owner, member] = (await Promise.all(
      ['report-owner', 'report-member'].map(registerAndLogin),
    )) as [Session, Session];
    await seedAuthority([owner, member]);
    const circleId = await createCircle(owner, 'Report escape');
    const invited = await json(owner, `/v1/circles/${circleId}/invitations`, 'POST', {
      account_id: member.accountId,
      role: 'member',
    });
    const invitationId = ((await invited.json()) as { invitation_id: string }).invitation_id;
    expect(
      (await json(member, `/v1/circles/${circleId}/invitations/${invitationId}/accept`, 'POST', {}))
        .status,
    ).toBe(201);
    const note = await json(member, `/v1/circles/${circleId}/notes`, 'POST', {
      body: 'never-in-safety-vault-plaintext',
    });
    const noteId = ((await note.json()) as { id: string }).id;
    await insertModeDecision(
      owner.accountId,
      await credentialFor(owner.accountId),
      'circles',
      'deny',
    );
    const report = await json(owner, `/v1/circles/${circleId}/notes/${noteId}/report`, 'POST', {
      subject_account_id: member.accountId,
      target_type: 'note',
      target_id: noteId,
      category: 'harassment',
      idempotency_key: key('circle-note-report'),
    });
    expect(report.status).toBe(201);
    const vault = await pool.query(
      'SELECT encrypted_snapshot::text AS value FROM safety.evidence_snapshots ORDER BY created_at DESC LIMIT 1',
    );
    expect(vault.rows[0]?.value).not.toContain('never-in-safety-vault-plaintext');
  }, 90_000);
});
