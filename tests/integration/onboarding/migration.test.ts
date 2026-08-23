import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, MigrationRunner, createDb, createOnboardingRepository } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { aesGcmDecrypt } from '@wai/db';

declare const WAI_MIGRATIONS_DIR: string;
const KEY = Buffer.alloc(32, 7);
let started: StartedInfra;
let pool: ReturnType<typeof createPool>;
let accountId: string;

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  accountId = randomUUID();
  await pool.query(
    `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at) VALUES ($1,$2,'x','x','test','enabled','registered','system',now(),0,now(),now())`,
    [accountId, 'a'.repeat(64)],
  );
});
afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('ONB-01 real PostgreSQL persistence', () => {
  it('round-trips text arrays, Dates, encrypted values and stable idempotency replay', async () => {
    const repo = createOnboardingRepository(createDb(pool), new Map([['test', KEY]]), 'test');
    const session = await repo.createSession({
      accountId,
      purpose: 'discovery',
      modes: ['friends', 'activities', 'dating'],
      datingEnabled: true,
      idempotencyKey: 'onb-real-session-0001',
      payloadDigest: '0'.repeat(64),
    });
    expect(session.modes).toEqual(['friends', 'activities', 'dating']);
    const answered = await repo.appendAnswer({
      accountId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      mode: 'friends',
      expectedRevision: 0,
      text: 'slow letters',
      idempotencyKey: 'onb-real-answer-0001',
      payloadDigest: '1'.repeat(64),
    });
    expect(answered.answerRevision).toBe(1);
    expect(
      (
        await repo.appendAnswer({
          accountId,
          sessionId: session.sessionId,
          purpose: 'discovery',
          mode: 'friends',
          expectedRevision: 0,
          text: 'slow letters',
          idempotencyKey: 'onb-real-answer-0001',
          payloadDigest: '1'.repeat(64),
        })
      ).answerRevision,
    ).toBe(1);
    await expect(
      repo.appendAnswer({
        accountId,
        sessionId: session.sessionId,
        purpose: 'discovery',
        mode: 'friends',
        expectedRevision: 0,
        text: 'different answer',
        idempotencyKey: 'onb-real-answer-0001',
        payloadDigest: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/idempotency/);
    expect(await repo.answerTexts(accountId, session.sessionId, 'discovery', 'friends')).toEqual([
      'slow letters',
    ]);
    const proposal = await repo.saveProposal({
      accountId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      mode: 'friends',
      answerRevision: 1,
      modesVersion: 1,
      extraction: {
        confidence: 0.8,
        provenance: 'local_rules',
        preferences: [
          {
            mode: 'friends',
            criterion: 'communication_style',
            strength: 'strong_preference',
            value: 'slow',
            deal_breaker: false,
          },
        ],
      },
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      idempotencyKey: 'onb-real-proposal-0001',
      payloadDigest: '2'.repeat(64),
    });
    expect(proposal.expiresAt).toBeInstanceOf(Date);
    expect((await repo.getProposal(accountId, proposal.proposalId))?.expiresAt).toBeInstanceOf(
      Date,
    );
    const record = await repo.confirm({
      accountId,
      proposalId: proposal.proposalId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      expectedVersion: 0,
      expectedAnswerRevision: 1,
      modesVersion: 1,
      modes: session.modes,
      preferences: proposal.preferences,
      idempotencyKey: 'onb-real-replay-0001',
      payloadDigest: 'a'.repeat(64),
    });
    expect(record.version).toBe(1);
    expect(
      (
        await repo.confirm({
          accountId,
          proposalId: proposal.proposalId,
          sessionId: session.sessionId,
          purpose: 'discovery',
          expectedVersion: 0,
          expectedAnswerRevision: 1,
          modesVersion: 1,
          modes: session.modes,
          preferences: proposal.preferences,
          idempotencyKey: 'onb-real-replay-0001',
          payloadDigest: 'a'.repeat(64),
        })
      ).version,
    ).toBe(1);
    await expect(
      repo.confirm({
        accountId,
        proposalId: proposal.proposalId,
        sessionId: session.sessionId,
        purpose: 'discovery',
        expectedVersion: 0,
        expectedAnswerRevision: 1,
        modesVersion: 1,
        modes: session.modes,
        preferences: proposal.preferences,
        idempotencyKey: 'onb-real-replay-0001',
        payloadDigest: 'b'.repeat(64),
      }),
    ).rejects.toThrow('idempotency');
    const stored = await pool.query<{ preferences_ciphertext: string; normalized_json: unknown }>(
      'SELECT preferences_ciphertext,normalized_json FROM onboarding.preference_sets WHERE account_id=$1 AND current',
      [accountId],
    );
    expect(stored.rows[0]?.preferences_ciphertext).not.toContain('slow');
    expect(JSON.stringify(stored.rows[0]?.normalized_json)).not.toContain('slow');
    expect(
      aesGcmDecrypt(KEY, {
        ciphertext: stored.rows[0]!.preferences_ciphertext,
        nonce: (
          await pool.query<{ preferences_nonce: string }>(
            'SELECT preferences_nonce FROM onboarding.preference_sets WHERE account_id=$1 AND current',
            [accountId],
          )
        ).rows[0]!.preferences_nonce,
      }),
    ).toContain('slow');
    const ciphertexts = await pool.query<{ answer_ciphertext: string; payload_ciphertext: string }>(
      `SELECT a.answer_ciphertext, p.payload_ciphertext
         FROM onboarding.answer_revisions a
         JOIN onboarding.extraction_proposals p ON p.session_id=a.session_id
        WHERE a.session_id=$1`,
      [session.sessionId],
    );
    expect(JSON.stringify(ciphertexts.rows)).not.toMatch(/slow|voice notes/i);

    const correctionSource = await repo.saveProposal({
      accountId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      mode: 'friends',
      answerRevision: 1,
      modesVersion: 1,
      extraction: {
        confidence: 0.7,
        provenance: 'local_rules',
        preferences: proposal.preferences,
      },
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      idempotencyKey: 'onb-real-correction-source-0001',
      payloadDigest: '3'.repeat(64),
    });
    await expect(
      repo.correct({
        accountId,
        proposalId: correctionSource.proposalId,
        sessionId: session.sessionId,
        purpose: 'discovery',
        expectedVersion: 0,
        expectedProposalVersion: 1,
        field: 'communication_style',
        correction: 'stale correction',
        idempotencyKey: 'onb-real-correction-stale-0001',
        payloadDigest: '2'.repeat(64),
      }),
    ).rejects.toThrow(/version conflict/);
    const correction = await repo.correct({
      accountId,
      proposalId: correctionSource.proposalId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      expectedVersion: 1,
      expectedProposalVersion: 1,
      field: 'communication_style',
      correction: 'fast voice notes',
      idempotencyKey: 'onb-real-correction-0001',
      payloadDigest: 'd'.repeat(64),
    });
    const correctionReplay = await repo.correct({
      accountId,
      proposalId: correctionSource.proposalId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      expectedVersion: 1,
      expectedProposalVersion: 1,
      field: 'communication_style',
      correction: 'fast voice notes',
      idempotencyKey: 'onb-real-correction-0001',
      payloadDigest: 'd'.repeat(64),
    });
    expect(correctionReplay).toEqual(correction);
    await expect(
      repo.correct({
        accountId,
        proposalId: correctionSource.proposalId,
        sessionId: session.sessionId,
        purpose: 'discovery',
        expectedVersion: 1,
        expectedProposalVersion: 1,
        field: 'communication_style',
        correction: 'different correction',
        idempotencyKey: 'onb-real-correction-0001',
        payloadDigest: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/idempotency/);
    const correctedProposal = await repo.getProposal(accountId, correction.proposalId);
    expect(correctedProposal?.proposalVersion).toBe(2);
    expect(correctedProposal?.preferences[0]?.value).toBe('fast voice notes');
    const correctedRecord = await repo.confirm({
      accountId,
      proposalId: correction.proposalId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      expectedVersion: 1,
      expectedAnswerRevision: 1,
      modesVersion: 1,
      modes: session.modes,
      preferences: correctedProposal!.preferences,
      idempotencyKey: 'onb-real-correction-confirm-0001',
      payloadDigest: 'e'.repeat(64),
    });
    expect(correctedRecord.preferences[0]?.value).toBe('fast voice notes');
    const raceSource = await repo.saveProposal({
      accountId,
      sessionId: session.sessionId,
      purpose: 'discovery',
      mode: 'friends',
      answerRevision: 1,
      modesVersion: 1,
      extraction: {
        confidence: 0.7,
        provenance: 'local_rules',
        preferences: correctedProposal!.preferences,
      },
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      idempotencyKey: 'onb-real-race-source-0001',
      payloadDigest: '4'.repeat(64),
    });
    const correctionRace = await Promise.allSettled([
      repo.correct({
        accountId,
        proposalId: raceSource.proposalId,
        sessionId: session.sessionId,
        purpose: 'discovery',
        expectedVersion: 2,
        expectedProposalVersion: 1,
        field: 'communication_style',
        correction: 'race one',
        idempotencyKey: 'onb-real-correction-race-a',
        payloadDigest: '3'.repeat(64),
      }),
      repo.correct({
        accountId,
        proposalId: raceSource.proposalId,
        sessionId: session.sessionId,
        purpose: 'discovery',
        expectedVersion: 2,
        expectedProposalVersion: 1,
        field: 'communication_style',
        correction: 'race two',
        idempotencyKey: 'onb-real-correction-race-b',
        payloadDigest: '4'.repeat(64),
      }),
    ]);
    expect(correctionRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(correctionRace.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('keeps current sets independent by purpose and serializes concurrent first writes', async () => {
    const repo = createOnboardingRepository(createDb(pool), new Map([['test', KEY]]), 'test');
    const input = {
      accountId,
      purpose: 'profile' as const,
      expectedVersion: 0,
      modesVersion: 1,
      modes: ['friends'] as const,
      mode: 'friends' as const,
      preferences: [
        {
          mode: 'friends' as const,
          criterion: 'values' as const,
          strength: 'weak_preference' as const,
          value: 'kind',
          deal_breaker: false,
        },
      ],
      payloadDigest: 'c'.repeat(64),
    };
    const results = await Promise.allSettled([
      repo.replacePreferences({ ...input, idempotencyKey: 'onb-concurrent-a-0001' }),
      repo.replacePreferences({ ...input, idempotencyKey: 'onb-concurrent-b-0001' }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect((await repo.currentPreferences(accountId, 'profile'))?.purpose).toBe('profile');
    expect((await repo.currentPreferences(accountId, 'discovery'))?.purpose).toBe('discovery');
  });

  it('rejects non-closed or value-bearing normalized projections in PostgreSQL', async () => {
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM onboarding.preference_sets WHERE account_id=$1 AND purpose='discovery' AND current`,
      [accountId],
    );
    const id = row.rows[0]!.id;
    await expect(
      pool.query(`UPDATE onboarding.preference_sets SET normalized_json=$1 WHERE id=$2`, [
        JSON.stringify([
          {
            mode: 'friends',
            criterion: 'secret',
            strength: 'weak_preference',
            deal_breaker: false,
          },
        ]),
        id,
      ]),
    ).rejects.toThrow(/normalized projection/);
    await expect(
      pool.query(`UPDATE onboarding.preference_sets SET normalized_json=$1 WHERE id=$2`, [
        JSON.stringify([
          {
            mode: 'friends',
            criterion: 'values',
            strength: 'weak_preference',
            deal_breaker: false,
            value: 'private',
          },
        ]),
        id,
      ]),
    ).rejects.toThrow(/normalized projection/);
    await pool.query(`UPDATE onboarding.preference_sets SET normalized_json=$1 WHERE id=$2`, [
      JSON.stringify([
        {
          mode: 'friends',
          criterion: 'communication_frequency',
          strength: 'weak_preference',
          deal_breaker: false,
        },
      ]),
      id,
    ]);
    const session = await pool.query<{ id: string }>(
      `SELECT id FROM onboarding.interview_sessions WHERE account_id=$1 AND purpose='discovery' AND state='active'`,
      [accountId],
    );
    await expect(
      pool.query(`UPDATE onboarding.interview_sessions SET modes=$1 WHERE id=$2`, [
        ['friends', 'friends'],
        session.rows[0]!.id,
      ]),
    ).rejects.toThrow(/modes must be unique/);
  });

  it('refuses a final preference write while the IAM account row is disabled', async () => {
    await pool.query(
      `UPDATE iam.accounts SET state='suspended',state_reason='admin_suspend',state_changed_at=now(),version=version+1 WHERE id=$1`,
      [accountId],
    );
    const repo = createOnboardingRepository(createDb(pool), new Map([['test', KEY]]), 'test');
    await expect(
      repo.replacePreferences({
        accountId,
        purpose: 'profile',
        expectedVersion: 1,
        modesVersion: 1,
        modes: ['friends'],
        mode: 'friends',
        preferences: [],
        idempotencyKey: 'onb-disabled-write-0001',
        payloadDigest: '1'.repeat(64),
      }),
    ).rejects.toThrow('onboarding_account_disabled');
    await pool.query(
      `UPDATE iam.accounts SET state='enabled',state_reason='registered',state_changed_at=now(),version=version+1 WHERE id=$1`,
      [accountId],
    );
  });

  it('keeps idempotency results encrypted and preference modes isolated', async () => {
    const repo = createOnboardingRepository(createDb(pool), new Map([['test', KEY]]), 'test');
    const session = await repo.createSession({
      accountId,
      purpose: 'profile',
      modes: ['friends', 'activities', 'dating'],
      datingEnabled: true,
      idempotencyKey: 'onb-r2-profile-session-0001',
      payloadDigest: 'c'.repeat(64),
    });
    const polluted = await repo.saveProposal({
      accountId,
      sessionId: session.sessionId,
      purpose: 'profile',
      mode: 'friends',
      answerRevision: 0,
      modesVersion: 1,
      extraction: {
        confidence: 0.9,
        provenance: 'local_rules',
        preferences: [
          {
            mode: 'activities',
            criterion: 'values',
            strength: 'strong_preference',
            value: 'friends-only source value',
            deal_breaker: false,
          },
        ],
      },
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      idempotencyKey: 'onb-r2-profile-proposal-0001',
      payloadDigest: '5'.repeat(64),
    });
    const currentBeforeConfirm = await repo.currentPreferences(accountId, 'profile');
    const expectedProfileVersion = currentBeforeConfirm?.version ?? 0;
    expect(polluted.preferences.every((preference) => preference.mode === 'friends')).toBe(true);
    await expect(
      repo.confirm({
        accountId,
        proposalId: polluted.proposalId,
        sessionId: session.sessionId,
        purpose: 'profile',
        expectedVersion: expectedProfileVersion,
        expectedAnswerRevision: 0,
        modesVersion: 1,
        modes: session.modes,
        preferences: [
          {
            mode: 'activities',
            criterion: 'values',
            strength: 'strong_preference',
            value: 'polluted client mode',
            deal_breaker: false,
          },
        ],
        idempotencyKey: 'onb-r2-profile-polluted-confirm-0001',
        payloadDigest: 'd'.repeat(64),
      }),
    ).rejects.toThrow(/version conflict/);
    const confirmed = await repo.confirm({
      accountId,
      proposalId: polluted.proposalId,
      sessionId: session.sessionId,
      purpose: 'profile',
      expectedVersion: expectedProfileVersion,
      expectedAnswerRevision: 0,
      modesVersion: 1,
      modes: session.modes,
      preferences: polluted.preferences,
      idempotencyKey: 'onb-r2-profile-confirm-0001',
      payloadDigest: '6'.repeat(64),
    });
    expect(confirmed.preferences.every((preference) => preference.mode === 'friends')).toBe(true);
    const activities = await repo.replacePreferences({
      accountId,
      purpose: 'profile',
      expectedVersion: expectedProfileVersion + 1,
      modesVersion: 1,
      modes: session.modes,
      mode: 'activities',
      preferences: [
        {
          mode: 'activities',
          criterion: 'availability',
          strength: 'weak_preference',
          value: 'weekday evenings',
          deal_breaker: false,
        },
      ],
      idempotencyKey: 'onb-r2-profile-replace-0001',
      payloadDigest: '7'.repeat(64),
    });
    expect(activities.preferences.map((preference) => preference.mode)).toEqual([
      'friends',
      'activities',
    ]);
    const idempotencyColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='onboarding' AND table_name='idempotency_keys' ORDER BY ordinal_position`,
    );
    expect(idempotencyColumns.rows.map((row) => row['column_name'])).not.toContain('result_json');
    expect(idempotencyColumns.rows.map((row) => row['column_name'])).toEqual(
      expect.arrayContaining(['result_ciphertext', 'result_nonce', 'result_key_id']),
    );
    const canary = await pool.query<Record<string, unknown>>(
      `SELECT table_schema,table_name,column_name FROM information_schema.columns
       WHERE table_schema='onboarding' AND column_name IN ('result_json','value','preferences','correction')`,
    );
    expect(canary.rows.map((row) => row['column_name'])).not.toContain('result_json');
    const stored = await pool.query<Record<string, unknown>>(
      `SELECT result_ciphertext,result_nonce,result_key_id FROM onboarding.idempotency_keys WHERE account_id=$1`,
      [accountId],
    );
    expect(JSON.stringify(stored.rows)).not.toMatch(/friends-only source value|weekday evenings/);
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='onboarding' AND table_type='BASE TABLE' ORDER BY table_name`,
    );
    const dumpParts: string[] = [];
    for (const table of tables.rows) {
      const rows = await pool.query<{ json: string }>(
        `SELECT to_json(t)::text AS json FROM onboarding."${table.table_name}" t`,
      );
      dumpParts.push(...rows.rows.map((row) => row['json']));
    }
    expect(dumpParts.join('\n')).not.toMatch(
      /friends-only source value|weekday evenings|polluted client mode/,
    );
  });

  it('serializes provider dispatch and consent/account locks in both race orders', async () => {
    const repo = createOnboardingRepository(createDb(pool), new Map([['test', KEY]]), 'test');
    const dispatchSession = await repo.currentSession(accountId, 'profile');
    expect(dispatchSession).not.toBeNull();
    const consent = await repo.saveConsent({
      accountId,
      purpose: 'profile',
      provider: 'test-provider',
      receiptVersion: 1,
      retention: 'session',
      granted: true,
      idempotencyKey: 'onb-r2-dispatch-grant-0001',
      payloadDigest: '8'.repeat(64),
    });
    expect(
      (
        await repo.saveConsent({
          accountId,
          purpose: 'profile',
          provider: 'test-provider',
          receiptVersion: 1,
          retention: 'session',
          granted: true,
          idempotencyKey: 'onb-r2-dispatch-grant-0001',
          payloadDigest: '8'.repeat(64),
        })
      ).consentId,
    ).toBe(consent.consentId);
    await expect(
      repo.saveConsent({
        accountId,
        purpose: 'profile',
        provider: 'test-provider',
        receiptVersion: 1,
        retention: 'none',
        granted: true,
        idempotencyKey: 'onb-r2-dispatch-grant-0001',
        payloadDigest: '7'.repeat(64),
      }),
    ).rejects.toThrow(/idempotency/);
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let adapterCalls = 0;
    const inFlight = repo.withAuthorizedProviderDispatch(
      {
        accountId,
        purpose: 'profile',
        provider: 'test-provider',
        consentId: consent.consentId,
        receiptVersion: 1,
        idempotencyKey: 'onb-r2-dispatch-a-0001',
        payloadDigest: '9'.repeat(64),
        sessionId: dispatchSession!.sessionId,
        mode: 'friends',
        answerRevision: 0,
        modesVersion: 1,
        expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      },
      async () => {
        adapterCalls += 1;
        await started;
        return {
          confidence: 0.5,
          provenance: 'local_rules',
          preferences: [],
        };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    let withdrawalDone = false;
    const withdrawal = repo
      .saveConsent({
        accountId,
        purpose: 'profile',
        provider: 'test-provider',
        receiptVersion: 2,
        retention: 'none',
        granted: false,
        idempotencyKey: 'onb-r2-dispatch-withdraw-0001',
        payloadDigest: 'a'.repeat(64),
      })
      .then((value) => {
        withdrawalDone = true;
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(withdrawalDone).toBe(false);
    expect(adapterCalls).toBe(1);
    release?.();
    await expect(inFlight).resolves.toBeDefined();
    await expect(withdrawal).resolves.toBeDefined();
    const denied = await expect(
      repo.withAuthorizedProviderDispatch(
        {
          accountId,
          purpose: 'profile',
          provider: 'test-provider',
          consentId: consent.consentId,
          receiptVersion: 1,
          idempotencyKey: 'onb-r2-dispatch-b-0001',
          payloadDigest: 'b'.repeat(64),
          sessionId: dispatchSession!.sessionId,
          mode: 'friends',
          answerRevision: 0,
          modesVersion: 1,
          expiresAt: new Date('2030-01-02T03:04:05.000Z'),
        },
        async () => {
          adapterCalls += 1;
          return { confidence: 0.5, provenance: 'local_rules', preferences: [] };
        },
      ),
    );
    await denied.rejects.toThrow(/consent/);
    expect(adapterCalls).toBe(1);
    const regranted = await repo.saveConsent({
      accountId,
      purpose: 'profile',
      provider: 'test-provider',
      receiptVersion: 3,
      retention: 'session',
      granted: true,
      idempotencyKey: 'onb-r2-dispatch-regrant-0001',
      payloadDigest: 'e'.repeat(64),
    });
    await pool.query(
      `UPDATE iam.accounts SET state='suspended',state_reason='admin_suspend',state_changed_at=now(),version=version+1 WHERE id=$1`,
      [accountId],
    );
    await expect(
      repo.withAuthorizedProviderDispatch(
        {
          accountId,
          purpose: 'profile',
          provider: 'test-provider',
          consentId: regranted.consentId,
          receiptVersion: 3,
          idempotencyKey: 'onb-r2-dispatch-disabled-0001',
          payloadDigest: 'f'.repeat(64),
          sessionId: dispatchSession!.sessionId,
          mode: 'friends',
          answerRevision: 0,
          modesVersion: 1,
          expiresAt: new Date('2030-01-02T03:04:05.000Z'),
        },
        async () => {
          adapterCalls += 1;
          return { confidence: 0.5, provenance: 'local_rules', preferences: [] };
        },
      ),
    ).rejects.toThrow('onboarding_account_disabled');
    expect(adapterCalls).toBe(1);
    await pool.query(
      `UPDATE iam.accounts SET state='enabled',state_reason='registered',state_changed_at=now(),version=version+1 WHERE id=$1`,
      [accountId],
    );
  });

  it('allows idempotency cascade only from the parent account delete', async () => {
    const doomedAccount = randomUUID();
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,version,created_at,updated_at)
       VALUES ($1,$2,'x','x','test','enabled','registered','system',now(),0,now(),now())`,
      [doomedAccount, 'd'.repeat(64)],
    );
    const repo = createOnboardingRepository(createDb(pool), new Map([['test', KEY]]), 'test');
    const doomedSession = await repo.createSession({
      accountId: doomedAccount,
      purpose: 'discovery',
      modes: ['friends'],
      datingEnabled: false,
      idempotencyKey: 'onb-r3-cascade-session-0001',
      payloadDigest: '1'.repeat(64),
    });
    await repo.appendAnswer({
      accountId: doomedAccount,
      sessionId: doomedSession.sessionId,
      purpose: 'discovery',
      mode: 'friends',
      expectedRevision: 0,
      text: 'cascade answer',
      idempotencyKey: 'onb-r3-cascade-answer-0001',
      payloadDigest: '2'.repeat(64),
    });
    const doomedProposal = await repo.saveProposal({
      accountId: doomedAccount,
      sessionId: doomedSession.sessionId,
      purpose: 'discovery',
      mode: 'friends',
      answerRevision: 1,
      modesVersion: 1,
      extraction: {
        confidence: 0.8,
        provenance: 'local_rules',
        preferences: [
          {
            mode: 'friends',
            criterion: 'values',
            strength: 'strong_preference',
            value: 'cascade value',
            deal_breaker: false,
          },
        ],
      },
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      idempotencyKey: 'onb-r3-cascade-proposal-0001',
      payloadDigest: '3'.repeat(64),
    });
    await repo.saveConsent({
      accountId: doomedAccount,
      purpose: 'discovery',
      provider: 'test-provider',
      receiptVersion: 1,
      retention: 'session',
      granted: true,
      idempotencyKey: 'onb-r3-cascade-consent-0001',
      payloadDigest: '4'.repeat(64),
    });
    await repo.replacePreferences({
      accountId: doomedAccount,
      purpose: 'discovery',
      expectedVersion: 0,
      modesVersion: 1,
      modes: ['friends'],
      mode: 'friends',
      preferences: doomedProposal.preferences,
      idempotencyKey: 'onb-r3-cascade-preference-0001',
      payloadDigest: '5'.repeat(64),
    });
    const correctionSource = await repo.saveProposal({
      accountId: doomedAccount,
      sessionId: doomedSession.sessionId,
      purpose: 'discovery',
      mode: 'friends',
      answerRevision: 1,
      modesVersion: 1,
      extraction: {
        confidence: 0.8,
        provenance: 'local_rules',
        preferences: doomedProposal.preferences,
      },
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      idempotencyKey: 'onb-r3-cascade-correction-source-0001',
      payloadDigest: '6'.repeat(64),
    });
    await repo.correct({
      accountId: doomedAccount,
      proposalId: correctionSource.proposalId,
      sessionId: doomedSession.sessionId,
      purpose: 'discovery',
      expectedVersion: 1,
      expectedProposalVersion: 1,
      field: 'values',
      correction: 'corrected cascade value',
      idempotencyKey: 'onb-r3-cascade-correction-0001',
      payloadDigest: '7'.repeat(64),
    });

    const idempotency = await pool.query<{ key_digest: string }>(
      `SELECT key_digest FROM onboarding.idempotency_keys WHERE account_id=$1 LIMIT 1`,
      [doomedAccount],
    );
    expect(idempotency.rows[0]).toBeDefined();
    await expect(
      pool.query(
        `UPDATE onboarding.idempotency_keys SET created_at=created_at WHERE account_id=$1`,
        [doomedAccount],
      ),
    ).rejects.toThrow(/immutable|append-only/);
    await expect(
      pool.query(`DELETE FROM onboarding.idempotency_keys WHERE account_id=$1`, [doomedAccount]),
    ).rejects.toThrow(/immutable|append-only/);

    await pool.query(`CREATE OR REPLACE FUNCTION onboarding.r3_nested_delete_idempotency()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM onboarding.idempotency_keys WHERE account_id=OLD.account_id;
        RETURN OLD;
      END $$`);
    await pool.query(`CREATE TRIGGER onboarding_r3_nested_delete_idempotency
      AFTER DELETE ON onboarding.preference_sets
      FOR EACH ROW EXECUTE FUNCTION onboarding.r3_nested_delete_idempotency()`);
    await expect(
      pool.query(`DELETE FROM onboarding.preference_sets WHERE account_id=$1`, [doomedAccount]),
    ).rejects.toThrow(/immutable|append-only/);
    await pool.query(
      `DROP TRIGGER onboarding_r3_nested_delete_idempotency ON onboarding.preference_sets`,
    );
    await pool.query(`DROP FUNCTION onboarding.r3_nested_delete_idempotency()`);

    await expect(
      pool.query(`DELETE FROM iam.accounts WHERE id=$1`, [doomedAccount]),
    ).resolves.toBeDefined();
    const onboardingTables = [
      'interview_sessions',
      'answer_revisions',
      'extraction_proposals',
      'preference_sets',
      'provider_consents',
      'consent_receipts',
      'corrections',
      'idempotency_keys',
    ];
    for (const table of onboardingTables) {
      const remaining =
        table === 'answer_revisions'
          ? await pool.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM onboarding.answer_revisions a
               JOIN onboarding.interview_sessions s ON s.id=a.session_id
               WHERE s.account_id=$1`,
              [doomedAccount],
            )
          : await pool.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM onboarding."${table}" WHERE account_id=$1`,
              [doomedAccount],
            );
      expect(remaining.rows[0]?.n).toBe('0');
    }
  });

  it('supports the integrated 0015 to 0016 no-op, down, and up lifecycle', async () => {
    const runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, {
      through: '0016_onboarding.sql',
    });
    const noop = await runner.up();
    expect(noop.applied).toEqual([]);
    expect(noop.skipped.at(-1)).toBe('0016_onboarding.sql');
    expect(
      (
        await pool.query<{ name: string }>(
          `SELECT name FROM iam.schema_migrations WHERE name='0015_globalization.sql'`,
        )
      ).rows,
    ).toEqual([{ name: '0015_globalization.sql' }]);
    expect(await runner.down()).toBe('0016_onboarding.sql');
    expect(
      (await pool.query("SELECT to_regclass('onboarding.preference_sets') AS name")).rows[0]?.name,
    ).toBeNull();
    expect(
      (await pool.query("SELECT to_regclass('globalization.account_preferences') AS name")).rows[0]
        ?.name,
    ).toBe('globalization.account_preferences');
    const reapplied = await runner.up();
    expect(reapplied.applied).toEqual(['0016_onboarding.sql']);
    expect(
      (await pool.query("SELECT to_regclass('onboarding.preference_sets') AS name")).rows[0]?.name,
    ).toBe('onboarding.preference_sets');
  });
});
