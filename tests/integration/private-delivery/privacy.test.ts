import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  MigrationRunner,
  PgPrivateDeliveryRepository,
  PgConnectionRepository,
  PgSafetyRepository,
  createPool,
  parsePepper,
} from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { DatabasePrivateDeliveryPolicyGate } from '../../../apps/worker/src/private-delivery/database-policy-gate.js';

declare const WAI_MIGRATIONS_DIR: string;
const sender = '10000000-0000-4000-8000-000000000001';
const recipient = '10000000-0000-4000-8000-000000000002';
const other = '10000000-0000-4000-8000-000000000003';
const connection = '10000000-0000-4000-8000-000000000010';
const connectionOther = '10000000-0000-4000-8000-000000000011';
const letter = '10000000-0000-4000-8000-000000000020';
const revision = '10000000-0000-4000-8000-000000000021';
const letterTwo = '10000000-0000-4000-8000-000000000022';
const revisionTwo = '10000000-0000-4000-8000-000000000023';
const letterThree = '10000000-0000-4000-8000-000000000024';
const revisionThree = '10000000-0000-4000-8000-000000000025';
const letterFour = '10000000-0000-4000-8000-000000000026';
const revisionFour = '10000000-0000-4000-8000-000000000027';
const hash = 'b'.repeat(64);
const key = Buffer.alloc(32, 7);
const pepper = parsePepper('p'.repeat(32));
let infra: StartedInfra;
let pool: Pool;
let repo: PgPrivateDeliveryRepository;
let deliveredId: string;
const gatePolicy = '10000000-0000-4000-8000-000000000030';
const gatePolicyNext = '10000000-0000-4000-8000-000000000031';
const gatePolicyHash = '1'.repeat(64);
const gatePolicyNextHash = '2'.repeat(64);
const gateIdentitySender = '10000000-0000-4000-8000-000000000032';
const gateIdentityRecipient = '10000000-0000-4000-8000-000000000033';
const gateEvidenceSender = '10000000-0000-4000-8000-000000000034';
const gateEvidenceRecipient = '10000000-0000-4000-8000-000000000035';
const gateCredentialSender = '10000000-0000-4000-8000-000000000036';
const gateCredentialRecipient = '10000000-0000-4000-8000-000000000037';
const gateModeSender = '10000000-0000-4000-8000-000000000038';
const gateModeRecipient = '10000000-0000-4000-8000-000000000039';
const gatePartition = '10000000-0000-4000-8000-000000000040';
const gatePartitionFresh = '10000000-0000-4000-8000-000000000046';
const gateMembershipPolicy = '10000000-0000-4000-8000-000000000041';
const gateMembershipSender = '10000000-0000-4000-8000-000000000042';
const gateMembershipRecipient = '10000000-0000-4000-8000-000000000043';

const content = {
  title: 'Private title',
  body: { paragraphs: ['Private body'] },
  locale: 'en-US',
  country_code: 'US' as const,
  topics: ['friendship' as const],
  content_reminder: 'none' as const,
  pen_name: 'Pen name',
};

async function account(id: string, suffix: string) {
  const now = new Date();
  await pool.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,$2,'cipher','nonce','k','enabled','registered','system',$3,$3,$3)`,
    [id, suffix, now],
  );
}
async function makeLetter(id: string, rev: string) {
  const now = new Date();
  await pool.query('BEGIN');
  await pool.query(
    `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at) VALUES ($1,$2,'private_letter','draft',1,1,$3,$3)`,
    [id, sender, now],
  );
  await pool.query(
    `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at) VALUES ($1,$2,1,$3,'c','n','c','n','c','n','k',$4)`,
    [rev, id, hash, now],
  );
  await pool.query('COMMIT');
}

beforeAll(async () => {
  infra = await startTestInfra();
  pool = createPool(infra.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  await account(sender, 'sender');
  await account(recipient, 'recipient');
  await account(other, 'other');
  const now = new Date();
  await pool.query(
    `INSERT INTO connection.connections(id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at) VALUES ($1,$2,$3,$2,$3,'friends','accepted',1,$4,$4,$4)`,
    [connection, sender, recipient, now],
  );
  await pool.query(
    `INSERT INTO connection.connections(id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at) VALUES ($1,$2,$3,$2,$3,'friends','accepted',1,$4,$4,$4)`,
    [connectionOther, sender, other, now],
  );
  await makeLetter(letter, revision);
  await makeLetter(letterTwo, revisionTwo);
  await makeLetter(letterThree, revisionThree);
  await makeLetter(letterFour, revisionFour);
  repo = new PgPrivateDeliveryRepository(pool, { keyId: 'active', key, hmacKey: pepper });
  const gateNow = new Date();
  await pool.query('BEGIN');
  await pool.query(`SELECT set_config('app.eligibility_policy_publish','true',true)`);
  await pool.query(
    `INSERT INTO eligibility.jurisdiction_policies
       (id,jurisdiction_key,revision,status,content,content_hash,rule_hash,location_precision_policy,profiling_policy,retention_policy,legal_basis_refs,reviewed_by,reviewed_at,timezone,effective_from,effective_until,created_at)
     VALUES ($1,'US-G',1,'approved','{}',$2,$2,'country_only','derived_facts_only','test',$6,'reviewer',$3,'UTC',$3,'infinity',$3),
            ($4,'US-N',1,'approved','{}',$5,$5,'country_only','derived_facts_only','test',$6,'reviewer',$3,'UTC',$3,'infinity',$3)`,
    [gatePolicy, gatePolicyHash, gateNow, gatePolicyNext, gatePolicyNextHash, ['test']],
  );
  await pool.query('COMMIT');
  await pool.query(
    `INSERT INTO verification.membership_policies
       (id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,effective_from,effective_until,created_at)
     VALUES ($1,1,'approved',$2,'test','reviewer',$3,$3,'infinity',$3)`,
    [gateMembershipPolicy, '3'.repeat(64), gateNow],
  );
  await pool.query(
    `INSERT INTO verification.identity_cases(id,account_id,state,age_assurance_state,version,created_at,updated_at,verified_at)
     VALUES ($1,$2,'verified','attested',1,$5,$5,$5),($3,$4,'verified','attested',1,$5,$5,$5)`,
    [gateIdentitySender, sender, gateIdentityRecipient, recipient, gateNow],
  );
  await pool.query(
    `INSERT INTO eligibility.age_evidence
       (id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,created_at,verification_case_id,external_attestation_digest)
     VALUES ($1,$2,$3,'c','n','k','verification_provider',$6,$6,$7,$8),($4,$5,$3,'c','n','k','verification_provider',$6,$6,$9,$8)`,
    [
      gateEvidenceSender,
      sender,
      '4'.repeat(64),
      gateEvidenceRecipient,
      recipient,
      gateNow,
      gateIdentitySender,
      '5'.repeat(64),
      gateIdentityRecipient,
    ],
  );
  await pool.query(
    `INSERT INTO eligibility.age_credentials
       (id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,policy_revision,valid_from,valid_until,derived_at,derivation_version,created_at)
     VALUES ($1,$2,'adult','adult','externally_attested','verification_module',$3,$5,1,$7,'infinity',$7,1,$7),
            ($4,$6,'adult','adult','externally_attested','verification_module',$8,$5,1,$7,'infinity',$7,1,$7)`,
    [
      gateCredentialSender,
      sender,
      gateEvidenceSender,
      gateCredentialRecipient,
      gatePolicy,
      recipient,
      gateNow,
      gateEvidenceRecipient,
    ],
  );
  await pool.query(
    `INSERT INTO eligibility.mode_decisions
       (decision_id,account_id,scope,mode,decision,age_band,cohort_key,assurance_level,reason_codes,policy_id,policy_revision,policy_hash,credential_id,credential_hash,input_hash,evaluated_at,valid_until,engine_version,created_at)
     VALUES ($1,$2,'age_and_jurisdiction','friends','allow','adult','adult','externally_attested','{}',$5,1,$6,$7,$8,$9,$10,'infinity',1,$10),
            ($3,$4,'age_and_jurisdiction','friends','allow','adult','adult','externally_attested','{}',$5,1,$6,$11,$12,$13,$10,'infinity',1,$10)`,
    [
      gateModeSender,
      sender,
      gateModeRecipient,
      recipient,
      gatePolicy,
      gatePolicyHash,
      gateCredentialSender,
      '6'.repeat(64),
      '7'.repeat(64),
      gateNow,
      gateCredentialRecipient,
      '6'.repeat(64),
      '7'.repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO verification.membership_cases
       (id,account_id,policy_id,policy_revision,policy_content_hash,statement_category,consented_at,state,version,decided_at,created_at,updated_at)
     VALUES ($1,$2,$5,1,$6,'community_participation',$7,'approved',1,$7,$7,$7),($3,$4,$5,1,$6,'community_participation',$7,'approved',1,$7,$7,$7)`,
    [
      gateMembershipSender,
      sender,
      gateMembershipRecipient,
      recipient,
      gateMembershipPolicy,
      '3'.repeat(64),
      gateNow,
    ],
  );
  await pool.query(
    `INSERT INTO eligibility.partition_decisions
       (decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
     VALUES ($1,$2,$3,'adult','adult','adult','adult','direct_message','allow','{}',$4,$5,1,1,$6,$7,$8,$9::timestamptz - interval '30 minutes',1,$9::timestamptz)`,
    [
      gatePartition,
      sender,
      recipient,
      gatePolicy,
      gatePolicy,
      gatePolicyHash,
      gatePolicyHash,
      '8'.repeat(64),
      gateNow,
    ],
  );
}, 180_000);
afterAll(async () => {
  await pool?.end();
  await infra?.stop();
}, 180_000);

describe('PVL-01 real PostgreSQL privacy and worker state', () => {
  it('worker database gate binds current identity, credential, policy and fresh partition snapshot', async () => {
    const gate = new DatabasePrivateDeliveryPolicyGate(pool);
    const input = {
      actorAccountId: sender,
      subjectAccountId: recipient,
      capability: 'direct_message' as const,
      mode: 'friends' as const,
      surface: 'chat' as const,
      requireConnection: true as const,
      connectionId: connection,
      acceptedEpoch: 1,
    };
    await expect(gate.check(input)).resolves.toMatchObject({
      allowed: false,
      reason: 'PARTITION_DENIED',
    });
    await pool.query(
      `INSERT INTO eligibility.partition_decisions
         (decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
       VALUES ($1,$2,$3,'adult','adult','adult','adult','direct_message','allow','{}',$4,$5,1,1,$6,$7,$8,now(),1,now())`,
      [
        gatePartitionFresh,
        sender,
        recipient,
        gatePolicy,
        gatePolicy,
        gatePolicyHash,
        gatePolicyHash,
        'a'.repeat(64),
      ],
    );
    await expect(gate.check(input)).resolves.toMatchObject({ allowed: true });
    await pool.query(
      `UPDATE verification.identity_cases SET state='verified',age_assurance_state='attested',updated_at=now() WHERE account_id IN ($1,$2)`,
      [sender, recipient],
    );
    await expect(gate.check(input)).resolves.toMatchObject({ allowed: true });
    await pool.query(
      `UPDATE verification.identity_cases SET state='pending',age_assurance_state='pending',updated_at=now() WHERE account_id=$1`,
      [sender],
    );
    await expect(gate.check(input)).resolves.toMatchObject({
      allowed: false,
      reason: 'PARTITION_DENIED',
    });
    await pool.query(
      `UPDATE verification.identity_cases SET state='verified',age_assurance_state='attested',updated_at=now() WHERE account_id=$1`,
      [sender],
    );
    await pool.query(
      `UPDATE eligibility.age_credentials SET superseded_at=now() WHERE id IN ($1,$2)`,
      [gateCredentialSender, gateCredentialRecipient],
    );
    await pool.query(
      `UPDATE eligibility.age_evidence SET superseded_at=now() WHERE account_id=$1 AND superseded_at IS NULL`,
      [sender],
    );
    const selfEvidence = '10000000-0000-4000-8000-000000000044';
    const selfCredential = '10000000-0000-4000-8000-000000000045';
    const now = new Date();
    await pool.query(
      `INSERT INTO eligibility.age_evidence(id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,created_at) VALUES ($1,$2,$3,'c','n','k','self_declared',$4,$4)`,
      [selfEvidence, sender, '9'.repeat(64), now],
    );
    await pool.query(
      `INSERT INTO eligibility.age_credentials(id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,policy_revision,valid_from,valid_until,derived_at,derivation_version,created_at) VALUES ($1,$2,'adult','adult','self_declared','eligibility_self_declaration',$3,$4,1,$5,'infinity',$5,1,$5)`,
      [selfCredential, sender, selfEvidence, gatePolicy, now],
    );
    await expect(gate.check(input)).resolves.toMatchObject({
      allowed: false,
      reason: 'PARTITION_DENIED',
    });
  }, 30_000);

  it('private_letter_requires_an_active_accepted_connection', async () => {
    await expect(
      repo.createQueued({
        senderAccountId: sender,
        recipientAccountId: other,
        connectionId: connection,
        connectionEpoch: 1,
        mode: 'friends',
        purpose: 'private_letter_delivery',
        snapshot: {
          letterId: letter,
          revisionId: revision,
          revision: 1,
          sourceHash: hash,
          content,
        },
        idempotencyKey: 'no-connection-key',
      }),
    ).rejects.toThrow('CONNECTION_NOT_CURRENT');
  });

  it('delivery_snapshot_is_encrypted_immutable_and_idempotent', async () => {
    const first = await repo.createQueued({
      senderAccountId: sender,
      recipientAccountId: recipient,
      connectionId: connection,
      connectionEpoch: 1,
      mode: 'friends',
      purpose: 'private_letter_delivery',
      snapshot: { letterId: letter, revisionId: revision, revision: 1, sourceHash: hash, content },
      idempotencyKey: 'snapshot-idempotency-key',
    });
    deliveredId = first.deliveryId;
    const differentKey = await repo.createQueued({
      senderAccountId: sender,
      recipientAccountId: recipient,
      connectionId: connection,
      connectionEpoch: 1,
      mode: 'friends',
      purpose: 'private_letter_delivery',
      snapshot: { letterId: letter, revisionId: revision, revision: 1, sourceHash: hash, content },
      idempotencyKey: 'snapshot-business-duplicate-key',
    });
    expect(differentKey.deliveryId).toBe(first.deliveryId);
    const replay = await repo.replayCreate({
      senderAccountId: sender,
      idempotencyKey: 'snapshot-idempotency-key',
      payload: {
        recipient_id: recipient,
        letter_id: letter,
        revision: 1,
        purpose: 'private_letter_delivery',
      },
    });
    expect(replay?.deliveryId).toBe(first.deliveryId);
    const lease = await repo.claim({
      workerId: 'test-worker',
      leaseMs: 30_000,
      deliveryId: first.deliveryId,
    });
    expect(lease).not.toBeNull();
    await expect(
      repo.complete({ deliveryId: first.deliveryId, leaseToken: lease!.leaseToken }),
    ).resolves.toBe('delivered');
    await expect(
      repo.complete({ deliveryId: first.deliveryId, leaseToken: lease!.leaseToken }),
    ).resolves.toBe('stale');
    const row = (
      await pool.query(
        `SELECT snapshot_body_ciphertext,state FROM private_delivery.deliveries WHERE id=$1`,
        [first.deliveryId],
      )
    ).rows[0] as { snapshot_body_ciphertext: string; state: string };
    expect(row.state).toBe('delivered');
    expect(row.snapshot_body_ciphertext).not.toContain('Private body');
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM private_delivery.notification_outbox WHERE delivery_id=$1`,
          [first.deliveryId],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it('reclaims expired leases, rejects stale tokens, and durably fails at the attempt cap', async () => {
    const queued = await repo.createQueued({
      senderAccountId: sender,
      recipientAccountId: recipient,
      connectionId: connection,
      connectionEpoch: 1,
      mode: 'friends',
      purpose: 'private_letter_delivery',
      snapshot: {
        letterId: letterTwo,
        revisionId: revisionTwo,
        revision: 1,
        sourceHash: hash,
        content,
      },
      idempotencyKey: 'lease-retry-idempotency-key',
    });
    const first = await repo.claim({
      workerId: 'lease-a',
      leaseMs: 100,
      deliveryId: queued.deliveryId,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await repo.claim({
      workerId: 'lease-b',
      leaseMs: 30_000,
      deliveryId: queued.deliveryId,
    });
    expect(second?.leaseToken).toBeTruthy();
    await expect(
      repo.complete({ deliveryId: queued.deliveryId, leaseToken: first!.leaseToken }),
    ).resolves.toBe('stale');
    await expect(
      repo.retry({
        deliveryId: queued.deliveryId,
        leaseToken: second!.leaseToken,
        reason: 'POLICY_UNAVAILABLE',
        retryAfterMs: 1,
      }),
    ).resolves.toBe('retrying');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const lease = await repo.claim({
        workerId: `lease-${attempt + 2}`,
        leaseMs: 30_000,
        deliveryId: queued.deliveryId,
      });
      expect(lease).not.toBeNull();
      await expect(
        repo.retry({
          deliveryId: queued.deliveryId,
          leaseToken: lease!.leaseToken,
          reason: 'POLICY_UNAVAILABLE',
          retryAfterMs: 1,
        }),
      ).resolves.toMatch(/retrying|failed/);
    }
    expect(
      (
        await pool.query(`SELECT state,attempts FROM private_delivery.deliveries WHERE id=$1`, [
          queued.deliveryId,
        ])
      ).rows[0],
    ).toMatchObject({ state: 'failed', attempts: 5 });
    await expect(
      repo.withdraw({ senderAccountId: sender, deliveryId: queued.deliveryId }),
    ).rejects.toThrow('private delivery not found');
  }, 30_000);

  it('disconnect_between_enqueue_and_delivery serializes with completion', async () => {
    const queued = await repo.createQueued({
      senderAccountId: sender,
      recipientAccountId: other,
      connectionId: connectionOther,
      connectionEpoch: 1,
      mode: 'friends',
      purpose: 'private_letter_delivery',
      snapshot: {
        letterId: letterFour,
        revisionId: revisionFour,
        revision: 1,
        sourceHash: hash,
        content,
      },
      idempotencyKey: 'disconnect-race-idempotency-key',
    });
    const lease = await repo.claim({
      workerId: 'disconnect-worker',
      leaseMs: 30_000,
      deliveryId: queued.deliveryId,
    });
    const connections = new PgConnectionRepository(pool, pepper);
    const [disconnected, completion] = await Promise.all([
      connections.transition({
        connectionId: connectionOther,
        actorAccountId: other,
        action: 'disconnect',
        idempotencyKey: 'disconnect-race-key',
      }),
      repo.complete({ deliveryId: queued.deliveryId, leaseToken: lease!.leaseToken }),
    ]);
    expect(disconnected.state).toBe('disconnected');
    expect(['cancelled', 'delivered']).toContain(completion);
    if (completion === 'delivered')
      expect(await repo.getForRecipient(other, queued.deliveryId)).toBeNull();
  });

  it('block_between_enqueue_and_delivery_prevents_delivery', async () => {
    const queued = await repo.createQueued({
      senderAccountId: sender,
      recipientAccountId: recipient,
      connectionId: connection,
      connectionEpoch: 1,
      mode: 'friends',
      purpose: 'private_letter_delivery',
      snapshot: {
        letterId: letterThree,
        revisionId: revisionThree,
        revision: 1,
        sourceHash: hash,
        content,
      },
      idempotencyKey: 'block-race-idempotency-key',
    });
    const lease = await repo.claim({
      workerId: 'test-worker',
      leaseMs: 30_000,
      deliveryId: queued.deliveryId,
    });
    expect(lease).not.toBeNull();
    const safety = new PgSafetyRepository(pool, {
      vaultKey: { keyId: 'safety-test', key: Buffer.alloc(32, 8) },
    });
    const [block, completion] = await Promise.all([
      safety.createBlock({
        blockerAccountId: recipient,
        blockedAccountId: sender,
        reason: 'privacy',
        idempotencyKey: 'block-race-key',
      }),
      repo.complete({ deliveryId: queued.deliveryId, leaseToken: lease!.leaseToken }),
    ]);
    expect(block.state).toBe('active');
    expect(['cancelled', 'delivered']).toContain(completion);
    if (completion === 'delivered')
      expect(await repo.getForRecipient(recipient, queued.deliveryId)).toBeNull();
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM private_delivery.notification_outbox WHERE delivery_id=$1`,
          [queued.deliveryId],
        )
      ).rows[0].count,
    ).toBe(0);
    await safety.revokeBlock(recipient, sender);
  });

  it('recipient_cannot_read_another_members_delivery and cursor is actor-bound', async () => {
    expect(await repo.getForRecipient(other, deliveredId)).toBeNull();
    const page = await repo.list({ actorAccountId: recipient, surface: 'inbox', limit: 1 });
    expect(page.items.length).toBe(0);
    await expect(
      repo.list({
        actorAccountId: other,
        surface: 'inbox',
        cursor: page.nextCursor ?? 'bad',
        limit: 1,
      }),
    ).rejects.toThrow('INVALID_CURSOR');
  });

  it('withdraw_does_not_destroy_report_evidence', async () => {
    await repo.captureEvidence({
      deliveryId: deliveredId,
      actorAccountId: recipient,
      category: 'report',
    });
    await repo.withdraw({ senderAccountId: sender, deliveryId: deliveredId });
    const evidence = await pool.query(
      `SELECT ciphertext,legal_hold FROM private_delivery.evidence_snapshots WHERE delivery_id=$1 AND category='report'`,
      [deliveredId],
    );
    expect(evidence.rowCount).toBe(1);
    expect(evidence.rows[0].ciphertext).toBeTruthy();
    expect(evidence.rows[0].legal_hold).toBe(true);
  });
});
