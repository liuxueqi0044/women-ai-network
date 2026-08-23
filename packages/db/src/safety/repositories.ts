import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { aesGcmDecrypt, aesGcmEncrypt } from '../crypto.js';
import {
  canonicalEvidenceSnapshotSchema,
  actionReasonCodeSchema,
  type CanonicalEvidenceSnapshot,
  type SafetyBlockDecision,
  type SafetySurface,
  type SafetyVaultActor,
  type ActionReasonCode,
} from '@wai/contracts';

export interface SafetyCryptoKeyring {
  keyId: string;
  key: Buffer;
}
export interface SafetyRepositoryOptions {
  vaultKey?: SafetyCryptoKeyring;
}
export interface SafetyBlockRow {
  id: string;
  blockedAccountId: string;
  state: 'active' | 'revoked';
  createdAt: Date;
}
export interface SafetyReportRow {
  id: string;
  state: string;
  createdAt: Date;
  existing: boolean;
}
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const isUnique = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
const pairOf = (left: string, right: string): [string, string] =>
  left < right ? [left, right] : [right, left];

/** Transactional PostgreSQL safety repository; no process-local state is authoritative. */
export class PgSafetyRepository {
  private readonly vault: SafetyCryptoKeyring;
  constructor(
    private readonly pool: Pool,
    options: SafetyRepositoryOptions = {},
  ) {
    const raw = process.env['SAFETY_VAULT_KEY'];
    this.vault =
      options.vaultKey ??
      (raw === undefined
        ? (() => {
            throw new Error('safety_vault_key_unavailable');
          })()
        : { keyId: 'safety-v1', key: Buffer.from(raw, 'base64') });
    if (this.vault.key.length !== 32) throw new Error('safety_vault_key_invalid');
  }
  async createBlock(i: {
    blockerAccountId: string;
    blockedAccountId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<SafetyBlockRow> {
    if (i.blockerAccountId === i.blockedAccountId) throw new Error('SELF_BLOCK_FORBIDDEN');
    const idem = digest(i.idempotencyKey),
      request = digest(JSON.stringify({ blocked: i.blockedAccountId, reason: i.reason }));
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const [accountA, accountB] = pairOf(i.blockerAccountId, i.blockedAccountId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [i.blockerAccountId]);
      const prior = await c.query<{
        id: string;
        blocked_account_id: string;
        state: 'active' | 'revoked';
        created_at: Date;
        request_digest: string;
      }>(
        'SELECT id,blocked_account_id,state,created_at,request_digest FROM safety.blocks WHERE blocker_account_id=$1 AND idempotency_digest=$2',
        [i.blockerAccountId, idem],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== request) throw new Error('IDEMPOTENCY_CONFLICT');
        await c.query('COMMIT');
        const p = prior.rows[0];
        return {
          id: p.id,
          blockedAccountId: p.blocked_account_id,
          state: p.state,
          createdAt: p.created_at,
        };
      }
      const id = randomUUID(),
        now = new Date();
      const r = await c.query<{ created_at: Date }>(
        "INSERT INTO safety.blocks (id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING created_at",
        [id, i.blockerAccountId, i.blockedAccountId, i.reason, idem, request, now],
      );
      await this.audit(
        c,
        i.blockerAccountId,
        'block.created',
        'block',
        id,
        { reason: i.reason },
        now,
      );
      await c.query('COMMIT');
      return {
        id,
        blockedAccountId: i.blockedAccountId,
        state: 'active',
        createdAt: r.rows[0]!.created_at,
      };
    } catch (e) {
      await c.query('ROLLBACK');
      if (isUnique(e)) throw new Error('BLOCK_ALREADY_ACTIVE');
      throw e;
    } finally {
      c.release();
    }
  }
  async revokeBlock(blocker: string, blocked: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const [accountA, accountB] = pairOf(blocker, blocked);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      const r = await c.query<{ id: string }>(
        "UPDATE safety.blocks SET state='revoked',revoked_at=now() WHERE blocker_account_id=$1 AND blocked_account_id=$2 AND state='active' RETURNING id",
        [blocker, blocked],
      );
      if (r.rows[0])
        await this.audit(c, blocker, 'block.revoked', 'block', r.rows[0].id, {}, new Date());
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async listBlocks(accountId: string): Promise<SafetyBlockRow[]> {
    const r = await this.pool.query<{
      id: string;
      blocked_account_id: string;
      state: 'active' | 'revoked';
      created_at: Date;
    }>(
      "SELECT id,blocked_account_id,state,created_at FROM safety.blocks WHERE blocker_account_id=$1 AND state='active' ORDER BY created_at DESC",
      [accountId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      blockedAccountId: x.blocked_account_id,
      state: x.state,
      createdAt: x.created_at,
    }));
  }
  async isInteractionAllowed(
    actor: string,
    subject: string,
    _surface: SafetySurface,
  ): Promise<SafetyBlockDecision> {
    const r = await this.pool.query(
      "SELECT 1 FROM safety.blocks WHERE state='active' AND ((blocker_account_id=$1 AND blocked_account_id=$2) OR (blocker_account_id=$2 AND blocked_account_id=$1)) LIMIT 1",
      [actor, subject],
    );
    return r.rowCount === 0 ? { allowed: true } : { allowed: false, reason: 'ACTIVE_BLOCK' };
  }
  async createReport(i: {
    reporterAccountId: string;
    subjectAccountId: string;
    targetType: string;
    targetId: string;
    category: string;
    idempotencyKey: string;
    snapshot: CanonicalEvidenceSnapshot;
  }): Promise<SafetyReportRow> {
    if (i.reporterAccountId === i.subjectAccountId) throw new Error('SELF_REPORT_FORBIDDEN');
    const idem = digest(i.idempotencyKey),
      request = digest(
        JSON.stringify({
          subject: i.subjectAccountId,
          targetType: i.targetType,
          targetId: i.targetId,
          category: i.category,
        }),
      );
    const validated = canonicalEvidenceSnapshotSchema.parse(i.snapshot);
    if (
      validated.targetType !== i.targetType ||
      validated.reference.targetType !== i.targetType ||
      validated.reference.targetId !== i.targetId ||
      validated.category !== i.category
    )
      throw new Error('EVIDENCE_TARGET_MISMATCH');
    const plain = JSON.stringify(validated),
      enc = aesGcmEncrypt(this.vault.key, plain),
      now = new Date();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${i.reporterAccountId}:${idem}`,
      ]);
      const prior = await c.query<{
        id: string;
        state: string;
        created_at: Date;
        request_digest: string;
      }>(
        'SELECT id,state,created_at,request_digest FROM safety.reports WHERE reporter_account_id=$1 AND idempotency_digest=$2',
        [i.reporterAccountId, idem],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== request) throw new Error('IDEMPOTENCY_CONFLICT');
        await c.query('COMMIT');
        return {
          ...prior.rows[0],
          createdAt: prior.rows[0].created_at,
          existing: true,
        } as SafetyReportRow;
      }
      const id = randomUUID();
      await c.query(
        "INSERT INTO safety.reports (id,reporter_account_id,subject_account_id,target_type,target_id,category,idempotency_digest,request_digest,state,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$9)",
        [
          id,
          i.reporterAccountId,
          i.subjectAccountId,
          i.targetType,
          i.targetId,
          i.category,
          idem,
          request,
          now,
        ],
      );
      await c.query(
        'INSERT INTO safety.evidence_snapshots (id,report_id,encrypted_snapshot,snapshot_nonce,key_id,snapshot_hash,source_version,captured_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
        [
          randomUUID(),
          id,
          enc.ciphertext,
          enc.nonce,
          this.vault.keyId,
          digest(plain),
          i.snapshot.reference.sourceVersion,
          now,
        ],
      );
      await c.query(
        "INSERT INTO safety.cases (id,report_id,severity,queue,state,version,created_at,updated_at) VALUES ($1,$2,'medium','safety','open',0,$3,$3)",
        [randomUUID(), id, now],
      );
      await this.audit(
        c,
        i.reporterAccountId,
        'report.created',
        'report',
        id,
        { category: i.category, target_type: i.targetType },
        now,
      );
      await c.query('COMMIT');
      return { id, state: 'open', createdAt: now, existing: false };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async getReport(id: string, reporterAccountId: string): Promise<SafetyReportRow | null> {
    const r = await this.pool.query<{ id: string; state: string; created_at: Date }>(
      'SELECT id,state,created_at FROM safety.reports WHERE id=$1 AND reporter_account_id=$2',
      [id, reporterAccountId],
    );
    const x = r.rows[0];
    return x ? { id: x.id, state: x.state, createdAt: x.created_at, existing: true } : null;
  }
  async readEvidence(
    actor: SafetyVaultActor,
    snapshotId: string,
    purpose: string,
  ): Promise<CanonicalEvidenceSnapshot> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const allowed = actor.role === 'safety_operator' || actor.role === 'compliance_officer';
      const row = await c.query<{ encrypted_snapshot: string; snapshot_nonce: string }>(
        'SELECT encrypted_snapshot,snapshot_nonce FROM safety.evidence_snapshots WHERE id=$1',
        [snapshotId],
      );
      await c.query(
        "INSERT INTO safety.case_access_audit (case_id,actor_id,purpose,fields_class,decision,created_at) SELECT c.id,$2,$3,'vault',$4,now() FROM safety.cases c JOIN safety.evidence_snapshots e ON e.report_id=c.report_id WHERE e.id=$1",
        [snapshotId, actor.principalId, purpose, allowed ? 'allow' : 'deny'],
      );
      if (!allowed || !row.rows[0]) {
        await c.query('COMMIT');
        throw new Error('SAFETY_VAULT_ACCESS_DENIED');
      }
      const result = canonicalEvidenceSnapshotSchema.parse(
        JSON.parse(
          aesGcmDecrypt(this.vault.key, {
            ciphertext: row.rows[0].encrypted_snapshot,
            nonce: row.rows[0].snapshot_nonce,
          }),
        ),
      );
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  async setLegalHold(snapshotId: string, actorId: string, reasonCode: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      const result = await client.query(
        'INSERT INTO safety.evidence_holds (id,snapshot_id,actor_id,reason_code,created_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING RETURNING id',
        [id, snapshotId, actorId, reasonCode],
      );
      if (result.rows[0])
        await this.audit(
          client,
          actorId,
          'evidence.legal_hold_set',
          'evidence_hold',
          id,
          { reason_code: reasonCode },
          new Date(),
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async claimCase(
    caseId: string,
    owner: string,
    leaseMs = 60000,
  ): Promise<{ token: string; until: Date } | null> {
    const token = randomUUID(),
      until = new Date(Date.now() + leaseMs);
    const r = await this.pool.query<{ lease_until: Date }>(
      "UPDATE safety.cases SET lease_owner=$2,lease_token=$3,lease_until=$4,version=version+1,updated_at=now() WHERE id=$1 AND state NOT IN ('resolved','dismissed') AND (lease_until IS NULL OR lease_until<now()) RETURNING lease_until",
      [caseId, owner, token, until],
    );
    return r.rows[0] ? { token, until: r.rows[0].lease_until } : null;
  }
  async transitionCase(input: {
    caseId: string;
    owner: string;
    leaseToken: string;
    expectedVersion: number;
    state: string;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ version: number }>(
        "UPDATE safety.cases SET state=$5,version=version+1,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND lease_token=$3 AND lease_until>now() AND version=$4 AND state IN ('open','triaged','investigating','action_pending') RETURNING version",
        [input.caseId, input.owner, input.leaseToken, input.expectedVersion, input.state],
      );
      if (!result.rows[0]) throw new Error('CASE_LEASE_STALE');
      await this.audit(
        client,
        input.owner,
        'case.transitioned',
        'case',
        input.caseId,
        { state: input.state },
        new Date(),
      );
      await client.query('COMMIT');
      return result.rows[0].version;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async proposeAction(i: {
    caseId: string;
    actionType: string;
    proposerId: string;
    reasonCode: ActionReasonCode;
  }): Promise<string> {
    actionReasonCodeSchema.parse(i.reasonCode);
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO safety.actions (id,case_id,action_type,state,proposer_id,reason_code,created_at,updated_at) VALUES ($1,$2,$3,'proposed',$4,$5,now(),now())",
        [id, i.caseId, i.actionType, i.proposerId, i.reasonCode],
      );
      await this.audit(
        client,
        i.proposerId,
        'action.proposed',
        'action',
        id,
        { action_type: i.actionType, reason_code: i.reasonCode },
        new Date(),
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async approveAction(actionId: string, approverId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{ id: string; action_type: string }>(
        "UPDATE safety.actions SET state='approved',approver_id=$2,updated_at=now() WHERE id=$1 AND state='proposed' AND (action_type='temporary_restriction' OR proposer_id<>$2) RETURNING id,action_type",
        [actionId, approverId],
      );
      if (!r.rows[0]) throw new Error('SECOND_APPROVER_REQUIRED');
      await this.audit(
        client,
        approverId,
        'action.approved',
        'action',
        actionId,
        { action_type: r.rows[0].action_type },
        new Date(),
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async executeAction(actionId: string, token: string): Promise<'executed' | 'already_executed'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{ id: string; action_type: string }>(
        "UPDATE safety.actions SET state='executed',execution_token=$2,executed_at=now(),updated_at=now() WHERE id=$1 AND state='approved' RETURNING id,action_type",
        [actionId, token],
      );
      if (r.rows[0]) {
        await this.audit(
          client,
          'trusted-executor',
          'action.executed',
          'action',
          actionId,
          { action_type: r.rows[0].action_type },
          new Date(),
        );
        await client.query('COMMIT');
        return 'executed';
      }
      const e = await client.query<{ execution_token: string }>(
        "SELECT execution_token FROM safety.actions WHERE id=$1 AND state='executed'",
        [actionId],
      );
      if (e.rows[0]?.execution_token === token) {
        await client.query('COMMIT');
        return 'already_executed';
      }
      if (e.rows[0]) throw new Error('ACTION_EXECUTION_TOKEN_CONFLICT');
      throw new Error('ACTION_NOT_EXECUTABLE');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async createAppeal(i: {
    actionId: string;
    appellantAccountId: string;
    category: string;
    statement: string;
  }): Promise<string> {
    const e = aesGcmEncrypt(this.vault.key, i.statement),
      id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        "INSERT INTO safety.appeals (id,action_id,appellant_account_id,category,statement_ciphertext,statement_nonce,statement_key_id,state,created_at) SELECT $1,$2,$3,$4,$5,$6,$7,'submitted',now() WHERE EXISTS (SELECT 1 FROM safety.actions a JOIN safety.cases c ON c.id=a.case_id JOIN safety.reports r ON r.id=c.report_id WHERE a.id=$2 AND a.state='executed' AND r.subject_account_id=$3)",
        [id, i.actionId, i.appellantAccountId, i.category, e.ciphertext, e.nonce, this.vault.keyId],
      );
      if (!r.rowCount) throw new Error('ACTION_NOT_FOUND');
      await this.audit(
        client,
        i.appellantAccountId,
        'appeal.created',
        'appeal',
        id,
        { category: i.category },
        new Date(),
      );
      await client.query('COMMIT');
      return id;
    } catch (x) {
      await client.query('ROLLBACK');
      if (isUnique(x)) throw new Error('APPEAL_ALREADY_OPEN');
      throw x;
    } finally {
      client.release();
    }
  }
  private async audit(
    c: PoolClient,
    actor: string,
    event: string,
    type: string,
    id: string,
    metadata: Record<string, string>,
    now: Date,
  ): Promise<void> {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('safety:audit', 0))");
    const m = JSON.stringify(metadata),
      p = await c.query<{ event_hash: string }>(
        'SELECT event_hash FROM safety.audit_events ORDER BY id DESC LIMIT 1',
      ),
      prev = p.rows[0]?.event_hash ?? '',
      h = digest(`${prev}\0${actor}\0${event}\0${type}\0${id}\0${m}\0${now.toISOString()}`);
    await c.query(
      'INSERT INTO safety.audit_events (actor_id,event_type,entity_type,entity_id,metadata_json,previous_hash,event_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [actor, event, type, id, m, prev, h, now],
    );
  }
  async verifyAuditChain(): Promise<boolean> {
    const r = await this.pool.query<{
      previous_hash: string | null;
      event_hash: string;
      actor_id: string | null;
      event_type: string;
      entity_type: string;
      entity_id: string;
      metadata_json: string;
      created_at: Date;
    }>(
      'SELECT previous_hash,event_hash,actor_id,event_type,entity_type,entity_id,metadata_json,created_at FROM safety.audit_events ORDER BY id',
    );
    let previous = '';
    for (const x of r.rows) {
      if (x.previous_hash !== previous) return false;
      const expected = digest(
        `${previous}\0${x.actor_id ?? ''}\0${x.event_type}\0${x.entity_type}\0${x.entity_id}\0${x.metadata_json}\0${x.created_at.toISOString()}`,
      );
      if (expected !== x.event_hash) return false;
      previous = x.event_hash;
    }
    return true;
  }
}
