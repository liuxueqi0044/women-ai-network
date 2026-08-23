import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PgSafetyRepository } from '@wai/db';
import { aesGcmEncrypt } from '@wai/db';
import { canonicalEvidenceSnapshotSchema } from '@wai/contracts';

const suite = describe.skipIf(process.env['DATABASE_URL'] === undefined);
suite('SAF-01 real vault privacy', () => {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  const repo = new PgSafetyRepository(pool, {
    vaultKey: { keyId: 'privacy', key: Buffer.alloc(32, 9) },
  });
  let snapshotId = '';
  const reporter = '79999999-9999-4999-8999-999999999991';
  const subject = '79999999-9999-4999-8999-999999999992';
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES ($1,'privacy-r','x','x','k','enabled','registered','system',now(),now(),now()),($2,'privacy-s','x','x','k','enabled','registered','system',now(),now(),now()) ON CONFLICT DO NOTHING`,
      [reporter, subject],
    );
    const snapshot = canonicalEvidenceSnapshotSchema.parse({
      schemaVersion: 1,
      targetType: 'account',
      reference: { targetType: 'account', targetId: subject, sourceVersion: null },
      capturedAt: new Date().toISOString(),
      category: 'other',
      safeMetadata: { account_state: 'active' },
    });
    const report = await repo.createReport({
      reporterAccountId: reporter,
      subjectAccountId: subject,
      targetType: 'account',
      targetId: subject,
      category: 'other',
      idempotencyKey: 'privacy-report-00001',
      snapshot,
    });
    const row = await pool.query<{ id: string }>(
      'SELECT id FROM safety.evidence_snapshots WHERE report_id=$1',
      [report.id],
    );
    snapshotId = row.rows[0]!.id;
  });
  afterAll(async () => {
    await pool.query('DELETE FROM iam.accounts WHERE id IN ($1,$2)', [reporter, subject]);
    await pool.end();
  });
  it('ordinary_admin_cannot_read_safety_vault', async () => {
    await expect(
      repo.readEvidence(
        { principalId: 'privacy-admin', role: 'ordinary_admin' },
        snapshotId,
        'privacy-test',
      ),
    ).rejects.toThrow('SAFETY_VAULT_ACCESS_DENIED');
    const audit = await pool.query(
      "SELECT decision FROM safety.case_access_audit WHERE actor_id='privacy-admin' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]?.decision).toBe('deny');
  });
  it('authorized_operator_decrypts_and_validates_snapshot', async () => {
    const value = await repo.readEvidence(
      { principalId: 'privacy-operator', role: 'safety_operator' },
      snapshotId,
      'privacy-test',
    );
    expect(value.schemaVersion).toBe(1);
    expect(value.reference.targetType).toBe(value.targetType);
  });
  it('tampered_ciphertext_or_schema_fails_closed', async () => {
    await pool.query(
      'ALTER TABLE safety.evidence_snapshots DISABLE TRIGGER safety_evidence_append_only',
    );
    try {
      await pool.query(
        "UPDATE safety.evidence_snapshots SET encrypted_snapshot='not-valid-ciphertext' WHERE id=$1",
        [snapshotId],
      );
    } finally {
      await pool.query(
        'ALTER TABLE safety.evidence_snapshots ENABLE TRIGGER safety_evidence_append_only',
      );
    }
    await expect(
      repo.readEvidence(
        { principalId: 'privacy-operator', role: 'safety_operator' },
        snapshotId,
        'tamper-ciphertext',
      ),
    ).rejects.toThrow();
    const malformed = aesGcmEncrypt(Buffer.alloc(32, 9), '{"schemaVersion":999}');
    await pool.query(
      'ALTER TABLE safety.evidence_snapshots DISABLE TRIGGER safety_evidence_append_only',
    );
    try {
      await pool.query(
        'UPDATE safety.evidence_snapshots SET encrypted_snapshot=$1,snapshot_nonce=$2 WHERE id=$3',
        [malformed.ciphertext, malformed.nonce, snapshotId],
      );
    } finally {
      await pool.query(
        'ALTER TABLE safety.evidence_snapshots ENABLE TRIGGER safety_evidence_append_only',
      );
    }
    await expect(
      repo.readEvidence(
        { principalId: 'privacy-operator', role: 'safety_operator' },
        snapshotId,
        'tamper-schema',
      ),
    ).rejects.toThrow();
  });
});
