import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import {
  aesGcmEncrypt,
  canonicalJsonHash,
  createDb,
  createPool,
  MigrationRunner,
  PgIntroductionRepository,
} from '@wai/db';
import { PgMutualMaterialization } from '../../../apps/api/src/connection/mutual-materialization.js';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
const key = Buffer.alloc(32, 9);
declare const WAI_MIGRATIONS_DIR: string;
let started: StartedInfra;
let pool: ReturnType<typeof createPool>;
let migrations: MigrationRunner;
beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  migrations = new MigrationRunner(pool, WAI_MIGRATIONS_DIR);
  await migrations.up();
  expect((await migrations.up()).applied).toHaveLength(0);
});
afterAll(async () => {
  expect(await migrations.down()).toBe('0019_circles.sql');
  expect(await migrations.down()).toBe('0018_notifications.sql');
  expect(await migrations.down()).toBe('0017_introductions.sql');
  const residue = await pool.query(
    `SELECT to_regprocedure('connection.mutual_materialization_immutable()') AS function_name`,
  );
  expect(residue.rows[0].function_name).toBeNull();
  expect(await migrations.up()).toEqual(
    expect.objectContaining({
      applied: ['0017_introductions.sql', '0018_notifications.sql', '0019_circles.sql'],
    }),
  );
  await pool.end();
  await started.stop();
});
async function account() {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at) VALUES($1,$2,'x','x','test','enabled','registered','system',now(),0,now(),now())`,
    [id, id.replaceAll('-', '')],
  );
  return id;
}
async function preferences(
  accountId: string,
  values = [
    {
      mode: 'friends',
      criterion: 'shared_interests',
      strength: 'strong_preference',
      value: 'music',
      deal_breaker: false,
    },
  ],
  modes = ['friends'],
) {
  const encrypted = aesGcmEncrypt(key, JSON.stringify(values));
  const normalized = values.map(({ value: _value, ...item }) => item);
  await pool.query(
    `INSERT INTO onboarding.preference_sets(id,account_id,purpose,version,current,modes,modes_version,normalized_json,preferences_ciphertext,preferences_nonce,preferences_key_id,confirmed_at,source) VALUES($1,$2,'discovery',1,true,$6::text[],1,$3,$4,$5,'test',now(),'manual')`,
    [
      randomUUID(),
      accountId,
      JSON.stringify(normalized),
      encrypted.ciphertext,
      encrypted.nonce,
      modes,
    ],
  );
}
const trustedGate = { check: async () => ({ allowed: true as const }) };
const trustedSafeView = {
  matchingFacts: async () => ({
    version: 'prf-matching-safe-v1',
    facts: [{ factKey: 'interests', value: 'music', visible: true, policyVersion: 'prf-1' }],
  }),
  matchingCard: async () => ({ displayName: 'Fixture member' }),
};
const trustedMaterialization = {
  materializeMutualIntroduction: async () => ({
    outcome: 'mutual' as const,
    connectionReference: randomUUID(),
  }),
};
describe('MCH-01 real PostgreSQL repository', () => {
  it('creates one bounded batch under concurrent requests and deterministic candidate', async () => {
    const actor = await account();
    const subject = await account();
    await preferences(actor);
    await preferences(subject);
    const repo = new PgIntroductionRepository(
      createDb(pool),
      Buffer.alloc(32, 5),
      new Map([['test', key]]),
      trustedGate,
      trustedMaterialization,
      trustedSafeView,
    );
    const batches = await Promise.all([
      repo.createBatch({ accountId: actor, mode: 'friends', limit: 10 }),
      repo.createBatch({ accountId: actor, mode: 'friends', limit: 10 }),
    ]);
    expect(batches[0].id).toBe(batches[1].id);
    const page = await repo.listCandidates({
      accountId: actor,
      batchId: batches[0].id,
      mode: 'friends',
      limit: 10,
    });
    expect(page.rows).toHaveLength(1);
    const candidate = page.rows[0]!;
    expect(candidate.score).toBe(6);
    expect(candidate.reasons).toEqual(['PREFERENCES_ALIGN']);
  });
  it('keeps score internal and decision payload idempotent at the DB boundary', async () => {
    const actor = await account();
    const subject = await account();
    const secondSubject = await account();
    await preferences(actor);
    await preferences(subject);
    await preferences(secondSubject);
    const repo = new PgIntroductionRepository(
      createDb(pool),
      Buffer.alloc(32, 5),
      new Map([['test', key]]),
      trustedGate,
      trustedMaterialization,
      trustedSafeView,
    );
    const batch = await repo.createBatch({ accountId: actor, mode: 'friends', limit: 10 });
    const page = await repo.listCandidates({
      accountId: actor,
      batchId: batch.id,
      mode: 'friends',
      limit: 10,
    });
    const row = page.rows.find((candidate) => candidate.subjectAccountId === subject)!;
    const first = await repo.decide({
      actorAccountId: actor,
      introductionId: row.id,
      batchId: batch.id,
      decision: 'pass',
      idempotencyKey: 'real-pass-key-00001',
      payloadDigest: '1'.repeat(64),
      actorProof: 'f'.repeat(64),
    });
    const replay = await repo.decide({
      actorAccountId: actor,
      introductionId: row.id,
      batchId: batch.id,
      decision: 'pass',
      idempotencyKey: 'real-pass-key-00001',
      payloadDigest: '1'.repeat(64),
      actorProof: 'f'.repeat(64),
    });
    expect(replay.row.id).toBe(first.row.id);
    const otherRow = page.rows.find((candidate) => candidate.id !== row.id)!;
    await expect(
      repo.decide({
        actorAccountId: actor,
        introductionId: otherRow.id,
        batchId: batch.id,
        decision: 'pass',
        idempotencyKey: 'real-pass-key-00001',
        payloadDigest: '1'.repeat(64),
        actorProof: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/idempotency/i);
    await expect(
      pool.query(
        `UPDATE introductions.idempotency_keys SET payload_digest=$1 WHERE account_id=$2 AND key_digest=$3`,
        ['9'.repeat(64), actor, canonicalJsonHash('real-pass-key-00001')],
      ),
    ).rejects.toThrow(/idempotency|immutable/i);
    await expect(
      repo.decide({
        actorAccountId: actor,
        introductionId: row.id,
        batchId: batch.id,
        decision: 'interested',
        idempotencyKey: 'real-pass-key-00001',
        payloadDigest: '2'.repeat(64),
        actorProof: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/idempotency|decision/i);
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='introductions' AND table_name='candidates'`,
    );
    expect(columns.rows.map((item) => item.column_name)).not.toContain('public_score');
    const cooldownDebug = await pool.query(
      'SELECT pair_key,until_at,mode FROM introductions.cooldowns',
    );
    expect(cooldownDebug.rows.map((row) => row.pair_key)).toContain(
      [actor, row.subjectAccountId].sort().join(':'),
    );
    const blockedBatch = await repo.createBatch({
      accountId: actor,
      mode: 'friends',
      limit: 10,
      now: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    expect(
      (
        await repo.listCandidates({
          accountId: actor,
          batchId: blockedBatch.id,
          mode: 'friends',
          limit: 10,
        })
      ).rows.some((item) => item.subjectAccountId === row.subjectAccountId),
    ).toBe(false);
    const cooledBatch = await repo.createBatch({
      accountId: actor,
      mode: 'friends',
      limit: 10,
      now: new Date(Date.now() + 26 * 60 * 60 * 1000),
    });
    expect(
      (
        await repo.listCandidates({
          accountId: actor,
          batchId: cooledBatch.id,
          mode: 'friends',
          limit: 10,
        })
      ).rows.some((item) => item.subjectAccountId === row.subjectAccountId),
    ).toBe(true);
  });
  it('scans deterministic candidate chunks past denied authorities until the batch is full', async () => {
    const actor = await account();
    await preferences(actor);
    const subjects = await Promise.all(
      Array.from({ length: 110 }, async () => {
        const subject = await account();
        await preferences(subject);
        return subject;
      }),
    );
    const denied = new Set<string>(subjects.slice(0, 100));
    const gate = {
      check: async ({ subjectAccountId }: { subjectAccountId: string }) =>
        denied.has(subjectAccountId)
          ? { allowed: false as const, reason: 'POLICY_DENIED' as const }
          : { allowed: true as const },
    };
    const repo = new PgIntroductionRepository(
      createDb(pool),
      Buffer.alloc(32, 5),
      new Map([['test', key]]),
      gate,
      trustedMaterialization,
      trustedSafeView,
    );
    const batch = await repo.createBatch({ accountId: actor, mode: 'friends', limit: 10 });
    const page = await repo.listCandidates({
      accountId: actor,
      batchId: batch.id,
      mode: 'friends',
      limit: 10,
    });
    expect(page.rows).toHaveLength(10);
    expect(page.rows.every((row) => !denied.has(row.subjectAccountId))).toBe(true);
  });
  it('isolates encrypted preference requirements by current mode', async () => {
    const actor = await account();
    const subject = await account();
    const values = [
      {
        mode: 'friends',
        criterion: 'shared_interests',
        strength: 'strong_preference',
        value: 'music',
        deal_breaker: false,
      },
      {
        mode: 'dating',
        criterion: 'language',
        strength: 'hard_requirement',
        value: 'never-match',
        deal_breaker: true,
      },
    ];
    await preferences(actor, values, ['friends', 'dating']);
    await preferences(subject, values, ['friends', 'dating']);
    const gate = {
      check: async ({ subjectAccountId }: { subjectAccountId: string }) =>
        subjectAccountId === subject
          ? { allowed: true as const }
          : { allowed: false as const, reason: 'POLICY_DENIED' as const },
    };
    const repo = new PgIntroductionRepository(
      createDb(pool),
      Buffer.alloc(32, 5),
      new Map([['test', key]]),
      gate,
      trustedMaterialization,
      trustedSafeView,
    );
    const batch = await repo.createBatch({ accountId: actor, mode: 'friends', limit: 10 });
    expect(
      (
        await repo.listCandidates({
          accountId: actor,
          batchId: batch.id,
          mode: 'friends',
          limit: 10,
        })
      ).rows.map((row) => row.subjectAccountId),
    ).toContain(subject);
  });
  it('rejects direct frozen-row mutation but permits IAM erasure cascade through CON bridge', async () => {
    const first = await account();
    const second = await account();
    const connectionId = randomUUID();
    const introductionId = randomUUID();
    await pool.query(
      `INSERT INTO connection.connections(id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at)
       VALUES($1,$2,$3,$2,$3,'friends','accepted',1,now(),now(),now())`,
      [connectionId, ...[first, second].sort()],
    );
    await pool.query(
      `INSERT INTO connection.mutual_materializations(id,introduction_id,pair_key,mode,actor_account_id,subject_account_id,actor_proof,subject_proof,materialization_key,connection_id,created_at)
       VALUES($1,$2,$3,'friends',$4,$5,$6,$7,$8,$9,now())`,
      [
        randomUUID(),
        introductionId,
        [first, second].sort().join(':'),
        first,
        second,
        'a'.repeat(64),
        'b'.repeat(64),
        randomUUID(),
        connectionId,
      ],
    );
    await expect(
      pool.query(`DELETE FROM connection.mutual_materializations WHERE introduction_id=$1`, [
        introductionId,
      ]),
    ).rejects.toThrow(/immutable|frozen/i);
    await expect(
      pool.query(`DELETE FROM connection.connections WHERE id=$1`, [connectionId]),
    ).rejects.toThrow(/immutable|disconnect/i);
    const batchId = randomUUID();
    const candidateId = randomUUID();
    await pool.query(
      `INSERT INTO introductions.batches(id,account_id,mode,algorithm_version,config_version,batch_limit,created_at,refresh_after) VALUES($1,$2,'friends','mch-01-deterministic-v1','mch-01-config-v1',1,now(),now())`,
      [batchId, first],
    );
    await pool.query(
      `INSERT INTO introductions.candidates(id,batch_id,actor_account_id,subject_account_id,mode,pair_key,reasons,visible_facts,score,reason_digest,created_at) VALUES($1,$2,$3,$4,'friends',$5,ARRAY['PREFERENCES_ALIGN'],ARRAY[]::text[],1,$6,now())`,
      [candidateId, batchId, first, second, [first, second].sort().join(':'), 'c'.repeat(64)],
    );
    await pool.query('DELETE FROM iam.accounts WHERE id=$1', [second]);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM introductions.candidates WHERE id=$1',
          [candidateId],
        )
      ).rows[0].count,
    ).toBe(0);
    await pool.query('DELETE FROM iam.accounts WHERE id=$1', [first]);
    const remaining = await pool.query(
      'SELECT count(*)::int AS count FROM connection.mutual_materializations WHERE connection_id=$1',
      [connectionId],
    );
    expect(remaining.rows[0].count).toBe(0);
  });
  it('materializes simultaneous opposite interests exactly once and never resurrects disconnects', async () => {
    const first = await account();
    const second = await account();
    const pepper = Buffer.alloc(32, 5);
    const gate = { check: async () => ({ allowed: true as const }) };
    const materializer = new PgMutualMaterialization(createDb(pool), gate, pepper);
    const firstIntro = randomUUID();
    const secondIntro = randomUUID();
    const firstDigest = 'batch-a:interested:' + '1'.repeat(64);
    const secondDigest = 'batch-b:interested:' + '2'.repeat(64);
    const proof = (accountId: string, introductionId: string, digest: string) =>
      createHmac('sha256', pepper)
        .update(`decision:${accountId}:${introductionId}:${digest}`)
        .digest('hex');
    const common = {
      mode: 'friends' as const,
      idempotencyKey: 'mch-mutual-barrier-key',
      currentGate: async () => true,
    };
    const [left, right] = await Promise.all([
      materializer.materializeMutualIntroduction({
        ...common,
        introductionId: firstIntro,
        actorAccountId: first,
        subjectAccountId: second,
        actorProof: proof(first, firstIntro, firstDigest),
        subjectProof: proof(second, secondIntro, secondDigest),
        actorDecisionDigest: firstDigest,
        subjectDecisionDigest: secondDigest,
        subjectIntroductionId: secondIntro,
      }),
      materializer.materializeMutualIntroduction({
        ...common,
        introductionId: secondIntro,
        actorAccountId: second,
        subjectAccountId: first,
        actorProof: proof(second, secondIntro, secondDigest),
        subjectProof: proof(first, firstIntro, firstDigest),
        actorDecisionDigest: secondDigest,
        subjectDecisionDigest: firstDigest,
        subjectIntroductionId: firstIntro,
      }),
    ]);
    expect(left.connectionReference).toBe(right.connectionReference);
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM connection.connections WHERE id=$1)::int AS connections,
              (SELECT count(*) FROM connection.transitions WHERE connection_id=$1 AND reason='mch_mutual')::int AS transitions,
              (SELECT count(*) FROM connection.mutual_materializations WHERE connection_id=$1)::int AS bridges`,
      [left.connectionReference],
    );
    expect(counts.rows[0]).toEqual({ connections: 1, transitions: 1, bridges: 1 });
    const faultRecovery = {
      materializeMutualIntroduction: async (
        input: Parameters<PgMutualMaterialization['materializeMutualIntroduction']>[0],
      ) => {
        const result = await materializer.materializeMutualIntroduction(input);
        throw new Error(`simulated_mch_crash_after_con_commit:${result.connectionReference}`);
      },
    };
    await expect(
      faultRecovery.materializeMutualIntroduction({
        ...common,
        introductionId: firstIntro,
        actorAccountId: first,
        subjectAccountId: second,
        actorProof: proof(first, firstIntro, firstDigest),
        subjectProof: proof(second, secondIntro, secondDigest),
        actorDecisionDigest: firstDigest,
        subjectDecisionDigest: secondDigest,
        subjectIntroductionId: secondIntro,
      }),
    ).rejects.toThrow(/simulated_mch_crash_after_con_commit/);
    const recovered = await materializer.materializeMutualIntroduction({
      ...common,
      introductionId: firstIntro,
      actorAccountId: first,
      subjectAccountId: second,
      actorProof: proof(first, firstIntro, firstDigest),
      subjectProof: proof(second, secondIntro, secondDigest),
      actorDecisionDigest: firstDigest,
      subjectDecisionDigest: secondDigest,
      subjectIntroductionId: secondIntro,
    });
    expect(recovered.connectionReference).toBe(left.connectionReference);
    await expect(
      materializer.materializeMutualIntroduction({
        ...common,
        introductionId: firstIntro,
        actorAccountId: first,
        subjectAccountId: second,
        actorProof: proof(first, firstIntro, firstDigest),
        subjectProof: proof(second, secondIntro, secondDigest),
        actorDecisionDigest: firstDigest,
        subjectDecisionDigest: secondDigest,
        subjectIntroductionId: secondIntro,
        currentGate: async () => false,
      }),
    ).rejects.toThrow('CON_MATERIALIZATION_GATE_DENIED');
    await pool.query(
      `UPDATE connection.connections SET state='disconnected',version=version+1,updated_at=now(),disconnected_at=now() WHERE id=$1`,
      [left.connectionReference],
    );
    await expect(
      materializer.materializeMutualIntroduction({
        ...common,
        introductionId: firstIntro,
        actorAccountId: first,
        subjectAccountId: second,
        actorProof: proof(first, firstIntro, firstDigest),
        subjectProof: proof(second, secondIntro, secondDigest),
        actorDecisionDigest: firstDigest,
        subjectDecisionDigest: secondDigest,
        subjectIntroductionId: secondIntro,
      }),
    ).rejects.toThrow('CONNECTION_TERMINAL');
  });
  it('recovers a production repository after CON commits before the MCH outcome', async () => {
    const first = await account();
    const second = await account();
    await preferences(first);
    await preferences(second);
    const firstGate = {
      check: async ({ subjectAccountId }: { subjectAccountId: string }) =>
        subjectAccountId === second
          ? { allowed: true as const }
          : { allowed: false as const, reason: 'POLICY_DENIED' as const },
    };
    const secondGate = {
      check: async ({ subjectAccountId }: { subjectAccountId: string }) =>
        subjectAccountId === first
          ? { allowed: true as const }
          : { allowed: false as const, reason: 'POLICY_DENIED' as const },
    };
    const pepper = Buffer.alloc(32, 5);
    const con = new PgMutualMaterialization(createDb(pool), trustedGate, pepper);
    const faultAfterCon = {
      materializeMutualIntroduction: async (
        input: Parameters<PgMutualMaterialization['materializeMutualIntroduction']>[0],
      ) => {
        const result = await con.materializeMutualIntroduction(input);
        throw new Error(`simulated_mch_outcome_crash:${result.connectionReference}`);
      },
    };
    const firstRepo = new PgIntroductionRepository(
      createDb(pool),
      pepper,
      new Map([['test', key]]),
      firstGate,
      con,
      trustedSafeView,
    );
    const secondRepo = new PgIntroductionRepository(
      createDb(pool),
      pepper,
      new Map([['test', key]]),
      secondGate,
      faultAfterCon,
      trustedSafeView,
    );
    const retryRepo = new PgIntroductionRepository(
      createDb(pool),
      pepper,
      new Map([['test', key]]),
      secondGate,
      con,
      trustedSafeView,
    );
    const firstBatch = await firstRepo.createBatch({
      accountId: first,
      mode: 'friends',
      limit: 10,
    });
    const secondBatch = await secondRepo.createBatch({
      accountId: second,
      mode: 'friends',
      limit: 10,
    });
    const firstRow = (
      await firstRepo.listCandidates({
        accountId: first,
        batchId: firstBatch.id,
        mode: 'friends',
        limit: 10,
      })
    ).rows[0]!;
    const secondRow = (
      await secondRepo.listCandidates({
        accountId: second,
        batchId: secondBatch.id,
        mode: 'friends',
        limit: 10,
      })
    ).rows[0]!;
    const idem = 'production-crash-recovery-key';
    await firstRepo.decide({
      actorAccountId: first,
      introductionId: firstRow.id,
      batchId: firstBatch.id,
      decision: 'interested',
      idempotencyKey: 'production-first-interest-key',
      payloadDigest: 'a'.repeat(64),
      actorProof: 'a'.repeat(64),
    });
    await expect(
      secondRepo.decide({
        actorAccountId: second,
        introductionId: secondRow.id,
        batchId: secondBatch.id,
        decision: 'interested',
        idempotencyKey: idem,
        payloadDigest: 'b'.repeat(64),
        actorProof: 'b'.repeat(64),
      }),
    ).rejects.toThrow(/simulated_mch_outcome_crash/);
    const interrupted = await pool.query(
      `SELECT (SELECT count(*) FROM connection.connections WHERE state='accepted' AND account_a=LEAST($1::uuid,$2::uuid) AND account_b=GREATEST($1::uuid,$2::uuid))::int AS connections,
              (SELECT count(*) FROM connection.mutual_materializations WHERE pair_key=$3)::int AS bridges,
              (SELECT count(*) FROM introductions.outcomes WHERE pair_key=$3)::int AS outcomes
       WHERE EXISTS (SELECT 1 FROM introductions.idempotency_keys WHERE account_id=$2 AND result->>'outcome' IS NULL)`,
      [first, second, [first, second].sort().join(':')],
    );
    expect(interrupted.rows[0]).toEqual({ connections: 1, bridges: 1, outcomes: 0 });
    const recovered = await retryRepo.decide({
      actorAccountId: second,
      introductionId: secondRow.id,
      batchId: secondBatch.id,
      decision: 'interested',
      idempotencyKey: idem,
      payloadDigest: 'b'.repeat(64),
      actorProof: 'b'.repeat(64),
    });
    expect(recovered.outcome).toBe('mutual');
    const complete = await pool.query(
      `SELECT (SELECT count(*) FROM connection.connections WHERE state='accepted' AND account_a=LEAST($1::uuid,$2::uuid) AND account_b=GREATEST($1::uuid,$2::uuid))::int AS connections,
              (SELECT count(*) FROM connection.mutual_materializations WHERE pair_key=$3)::int AS bridges,
              (SELECT count(*) FROM introductions.outcomes WHERE pair_key=$3)::int AS outcomes,
              (SELECT count(*) FROM introductions.idempotency_keys WHERE account_id=$2 AND result->>'outcome'='mutual')::int AS idempotencies`,
      [first, second, [first, second].sort().join(':')],
    );
    expect(complete.rows[0]).toEqual({ connections: 1, bridges: 1, outcomes: 1, idempotencies: 1 });
  });
  it('makes pass win an opposite-decision race and writes only a bounded cooldown', async () => {
    const first = await account();
    const second = await account();
    await preferences(first);
    await preferences(second);
    const firstRepo = new PgIntroductionRepository(
      createDb(pool),
      Buffer.alloc(32, 5),
      new Map([['test', key]]),
      {
        check: async ({ subjectAccountId }: { subjectAccountId: string }) =>
          subjectAccountId === second
            ? { allowed: true as const }
            : { allowed: false as const, reason: 'POLICY_DENIED' as const },
      },
      trustedMaterialization,
      trustedSafeView,
    );
    const secondRepo = new PgIntroductionRepository(
      createDb(pool),
      Buffer.alloc(32, 5),
      new Map([['test', key]]),
      {
        check: async ({ subjectAccountId }: { subjectAccountId: string }) =>
          subjectAccountId === first
            ? { allowed: true as const }
            : { allowed: false as const, reason: 'POLICY_DENIED' as const },
      },
      trustedMaterialization,
      trustedSafeView,
    );
    const firstBatch = await firstRepo.createBatch({
      accountId: first,
      mode: 'friends',
      limit: 10,
    });
    const secondBatch = await secondRepo.createBatch({
      accountId: second,
      mode: 'friends',
      limit: 10,
    });
    const firstRow = (
      await firstRepo.listCandidates({
        accountId: first,
        batchId: firstBatch.id,
        mode: 'friends',
        limit: 20,
      })
    ).rows.find((item) => item.subjectAccountId === second)!;
    const secondRow = (
      await secondRepo.listCandidates({
        accountId: second,
        batchId: secondBatch.id,
        mode: 'friends',
        limit: 20,
      })
    ).rows.find((item) => item.subjectAccountId === first)!;
    const [pass, interest] = await Promise.all([
      firstRepo.decide({
        actorAccountId: first,
        introductionId: firstRow.id,
        batchId: firstBatch.id,
        decision: 'pass',
        idempotencyKey: randomUUID(),
        payloadDigest: '3'.repeat(64),
        actorProof: 'x'.repeat(64),
      }),
      secondRepo.decide({
        actorAccountId: second,
        introductionId: secondRow.id,
        batchId: secondBatch.id,
        decision: 'interested',
        idempotencyKey: randomUUID(),
        payloadDigest: '4'.repeat(64),
        actorProof: 'y'.repeat(64),
      }),
    ]);
    expect(pass.outcome).toBeNull();
    expect(interest.outcome).toBeNull();
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM introductions.outcomes WHERE pair_key=$1)::int AS outcomes,
              (SELECT count(*) FROM introductions.cooldowns WHERE pair_key=$1 AND until_at>now())::int AS cooldowns`,
      [[firstRow.actorAccountId, firstRow.subjectAccountId].sort().join(':')],
    );
    expect(counts.rows[0]).toEqual({ outcomes: 0, cooldowns: 1 });
  });
});
