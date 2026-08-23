import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PgSafetyRepository } from '@wai/db';
import { canonicalEvidenceSnapshotSchema } from '@wai/contracts';

const suite = describe.skipIf(process.env['DATABASE_URL'] === undefined);
suite('SAF-01 real PostgreSQL invariants', () => {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  const repo = new PgSafetyRepository(pool, {
    vaultKey: { keyId: 'test', key: Buffer.alloc(32, 7) },
  });
  const a = '71111111-1111-4111-8111-111111111111';
  const b = '72222222-2222-4222-8222-222222222222';
  const report = '73333333-3333-4333-8333-333333333333';
  const kase = '74444444-4444-4444-8444-444444444444';
  const snapshotFor = (targetId: string, category: 'other' | 'threats' = 'other') =>
    canonicalEvidenceSnapshotSchema.parse({
      schemaVersion: 1,
      targetType: 'account',
      reference: { targetType: 'account', targetId, sourceVersion: null },
      capturedAt: new Date().toISOString(),
      category,
      safeMetadata: { account_state: 'active' },
    });
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,'s1','x','x','k','enabled','registered','system',now(),now(),now()),($2,'s2','x','x','k','enabled','registered','system',now(),now(),now()) ON CONFLICT DO NOTHING`,
      [a, b],
    );
  });
  afterAll(async () => {
    await pool.query('DELETE FROM iam.accounts WHERE id IN ($1,$2)', [a, b]);
    await pool.end();
  });
  it('global_block_contract_denies_every_surface', async () => {
    await repo.createBlock({
      blockerAccountId: a,
      blockedAccountId: b,
      reason: 'safety_concern',
      idempotencyKey: 'block-000000000001',
    });
    for (const surface of [
      'profile',
      'matching',
      'chat',
      'circle',
      'event',
      'notification',
    ] as const)
      expect((await repo.isInteractionAllowed(a, b, surface)).allowed).toBe(false);
    expect((await repo.isInteractionAllowed(b, a, 'profile')).allowed).toBe(false);
    await repo.revokeBlock(a, b);
    expect((await repo.isInteractionAllowed(a, b, 'profile')).allowed).toBe(true);
  });
  it('source_deletion_does_not_destroy_evidence_snapshot', async () => {
    const snapshot = canonicalEvidenceSnapshotSchema.parse({
      schemaVersion: 1,
      targetType: 'account',
      reference: { targetType: 'account', targetId: b, sourceVersion: null },
      capturedAt: new Date().toISOString(),
      category: 'other',
      safeMetadata: { account_state: 'active' },
    });
    await repo.createReport({
      reporterAccountId: a,
      subjectAccountId: b,
      targetType: 'account',
      targetId: b,
      category: 'other',
      idempotencyKey: 'report-000000000001',
      snapshot,
    });
    await pool.query('DELETE FROM iam.accounts WHERE id=$1', [b]);
    const r = await pool.query(
      'SELECT e.id FROM safety.evidence_snapshots e JOIN safety.reports r ON r.id=e.report_id WHERE r.subject_account_id IS NULL',
    );
    expect(r.rowCount).toBeGreaterThanOrEqual(1);
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,'s2','x','x','k','enabled','registered','system',now(),now(),now())`,
      [b],
    );
  });
  it('ordinary_admin_cannot_read_safety_vault', async () => {
    const row = await pool.query<{ id: string }>(
      "SELECT id FROM safety.evidence_snapshots WHERE key_id='test' LIMIT 1",
    );
    await expect(
      repo.readEvidence({ principalId: 'admin', role: 'ordinary_admin' }, row.rows[0]!.id, 'test'),
    ).rejects.toThrow('SAFETY_VAULT_ACCESS_DENIED');
    const audit = await pool.query(
      "SELECT decision FROM safety.case_access_audit WHERE actor_id='admin' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0].decision).toBe('deny');
    const allowed = await repo.readEvidence(
      { principalId: 'operator', role: 'safety_operator' },
      row.rows[0]!.id,
      'test',
    );
    expect(allowed.schemaVersion).toBe(1);
  });
  it('high_risk_action_requires_distinct_second_approver', async () => {
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,'s2','x','x','k','enabled','registered','system',now(),now(),now()) ON CONFLICT DO NOTHING`,
      [b],
    );
    await pool.query(
      "INSERT INTO safety.reports(id,reporter_account_id,subject_account_id,target_type,target_id,category,idempotency_digest,request_digest,created_at,updated_at) VALUES ($1,$2,$3,'account',$5,'other',$4,$4,now(),now()) ON CONFLICT DO NOTHING",
      [report, a, b, 'high-risk-test', b],
    );
    await pool.query(
      "INSERT INTO safety.cases(id,report_id,severity,queue,state,created_at,updated_at) VALUES ($1,$2,'high','safety','open',now(),now()) ON CONFLICT DO NOTHING",
      [kase, report],
    );
    await expect(
      pool.query(
        "INSERT INTO safety.actions(id,case_id,action_type,state,proposer_id,approver_id,reason_code,created_at,updated_at) VALUES (gen_random_uuid(),$1,'permanent_ban','approved','p','p','IMMINENT_SAFETY_RISK',now(),now())",
        [kase],
      ),
    ).rejects.toThrow();
  });
  it('legal_hold_and_append_only_are_database_enforced', async () => {
    const row = await pool.query<{ id: string }>(
      'SELECT id FROM safety.evidence_snapshots LIMIT 1',
    );
    await repo.setLegalHold(row.rows[0]!.id, 'compliance', 'LEGAL_REQUEST');
    await expect(
      pool.query("UPDATE safety.evidence_snapshots SET encrypted_snapshot='tampered' WHERE id=$1", [
        row.rows[0]!.id,
      ]),
    ).rejects.toThrow();
  });
  it('concurrent_report_same_key_is_one_snapshot_and_replay_is_stable', async () => {
    const key = 'concurrent-report-00001';
    const results = await Promise.all(
      [1, 2].map(() =>
        repo.createReport({
          reporterAccountId: a,
          subjectAccountId: b,
          targetType: 'account',
          targetId: b,
          category: 'other',
          idempotencyKey: key,
          snapshot: snapshotFor(b),
        }),
      ),
    );
    expect(results[0]!.id).toBe(results[1]!.id);
    const rows = await pool.query(
      'SELECT count(*)::int AS count FROM safety.evidence_snapshots e JOIN safety.reports r ON r.id=e.report_id WHERE r.id=$1',
      [results[0]!.id],
    );
    expect(rows.rows[0].count).toBe(1);
    await expect(
      repo.createReport({
        reporterAccountId: a,
        subjectAccountId: b,
        targetType: 'account',
        targetId: a,
        category: 'other',
        idempotencyKey: key,
        snapshot: snapshotFor(a),
      }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('case_lease_reclaim_rejects_stale_token_and_allows_current_token', async () => {
    const caseId = '76666666-6666-4666-8666-666666666666';
    await pool.query(
      "INSERT INTO safety.reports(id,reporter_account_id,subject_account_id,target_type,target_id,category,idempotency_digest,request_digest,created_at,updated_at) VALUES ($1,$2,$3,'account',$4,'other',$5,$5,now(),now()) ON CONFLICT DO NOTHING",
      [caseId, a, b, b, 'lease-report'],
    );
    await pool.query(
      "INSERT INTO safety.cases(id,report_id,severity,queue,state,version,created_at,updated_at) VALUES ($1,$2,'medium','safety','open',0,now(),now()) ON CONFLICT DO NOTHING",
      [caseId, caseId],
    );
    const first = await repo.claimCase(caseId, 'owner-1', 20);
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await repo.claimCase(caseId, 'owner-2', 1000);
    expect(second).not.toBeNull();
    await expect(
      repo.transitionCase({
        caseId,
        owner: 'owner-1',
        leaseToken: first!.token,
        expectedVersion: 1,
        state: 'triaged',
      }),
    ).rejects.toThrow('CASE_LEASE_STALE');
    await expect(
      repo.transitionCase({
        caseId,
        owner: 'owner-2',
        leaseToken: second!.token,
        expectedVersion: 2,
        state: 'triaged',
      }),
    ).resolves.toBe(3);
  });
  it('high_risk_positive_approval_execute_replay_and_token_conflict', async () => {
    const action = await repo.proposeAction({
      caseId: kase,
      actionType: 'permanent_ban',
      proposerId: 'proposer-1',
      reasonCode: 'IMMINENT_SAFETY_RISK',
    });
    await expect(repo.approveAction(action, 'proposer-1')).rejects.toThrow(
      'SECOND_APPROVER_REQUIRED',
    );
    await expect(repo.approveAction(action, 'approver-2')).resolves.toBeUndefined();
    await expect(repo.executeAction(action, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).resolves.toBe(
      'executed',
    );
    await expect(repo.executeAction(action, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).resolves.toBe(
      'already_executed',
    );
    await expect(
      repo.executeAction(action, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ).rejects.toThrow('ACTION_EXECUTION_TOKEN_CONFLICT');
  });
  it('appeal_requires_executed_action_and_subject_idor', async () => {
    const action = await repo.proposeAction({
      caseId: kase,
      actionType: 'temporary_restriction',
      proposerId: 'proposer-appeal',
      reasonCode: 'REPEAT_HARASSMENT',
    });
    await repo.approveAction(action, 'proposer-appeal');
    await repo.executeAction(action, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await expect(
      repo.createAppeal({
        actionId: action,
        appellantAccountId: a,
        category: 'incorrect_decision',
        statement: 'x',
      }),
    ).rejects.toThrow('ACTION_NOT_FOUND');
    await expect(
      repo.createAppeal({
        actionId: action,
        appellantAccountId: b,
        category: 'incorrect_decision',
        statement: 'x',
      }),
    ).resolves.toBeDefined();
  });
  it('audit_chain_linearizes_concurrent_appends_and_detects_tamper', async () => {
    await Promise.all(
      [1, 2, 3].map((n) =>
        repo.proposeAction({
          caseId: kase,
          actionType: 'temporary_restriction',
          proposerId: `audit-${n}`,
          reasonCode: 'REPEAT_HARASSMENT',
        }),
      ),
    );
    expect(await repo.verifyAuditChain()).toBe(true);
    await pool.query('ALTER TABLE safety.audit_events DISABLE TRIGGER safety_audit_append_only');
    await pool.query(
      "UPDATE safety.audit_events SET event_hash='0000000000000000000000000000000000000000000000000000000000000000' WHERE id=(SELECT max(id) FROM safety.audit_events)",
    );
    await pool.query('ALTER TABLE safety.audit_events ENABLE TRIGGER safety_audit_append_only');
    expect(await repo.verifyAuditChain()).toBe(false);
  });
});
