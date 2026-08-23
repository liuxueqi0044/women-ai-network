import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface VerificationStatusRow {
  identity: string;
  age_assurance: string;
  membership: string;
  appeal: string;
}

export interface IdentitySessionReservation {
  caseId: string;
  attemptId: string;
  attemptState: string;
  expiresAt: Date;
  existing: boolean;
}

export type ProviderEventClaimOutcome =
  | 'claimed'
  | 'retry_claimed'
  | 'processed'
  | 'in_progress'
  | 'retry_later'
  | 'conflict';

export type ProviderEventClaim =
  | { outcome: 'claimed' | 'retry_claimed'; processingToken: string }
  | { outcome: 'processed' | 'in_progress' | 'retry_later' | 'conflict' };

export interface IdentityCaseSnapshot {
  state: string;
  ageAssuranceState: string;
  lastProviderOccurredAt: Date | null;
  lastProviderEventId: string | null;
}

function first<T>(result: { rows: T[] }): T | null {
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}

/** PostgreSQL-owned verification state. No process-local state is authoritative. */
export class PgVerificationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Reserves a case/attempt under an account-scoped advisory transaction lock.
   * The placeholder values are non-sensitive and unique; the provider reference
   * replaces them only after it has been encrypted and keyed-digested.
   */
  async createCase(
    accountId: string,
    idempotencyKey: string,
    provider: string,
    now: Date,
  ): Promise<IdentitySessionReservation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [accountId]);

      const replay = await client.query<{
        case_id: string;
        attempt_id: string;
        attempt_state: string;
        expires_at: Date;
      }>(
        `SELECT c.id AS case_id, a.id AS attempt_id, a.state AS attempt_state, a.expires_at
           FROM verification.identity_cases c
           JOIN verification.verification_attempts a ON a.case_id = c.id
          WHERE c.account_id = $1 AND a.idempotency_key = $2
          ORDER BY a.created_at DESC LIMIT 1`,
        [accountId, idempotencyKey],
      );
      if (replay.rows[0] !== undefined) {
        await client.query('COMMIT');
        return {
          caseId: replay.rows[0].case_id,
          attemptId: replay.rows[0].attempt_id,
          attemptState: replay.rows[0].attempt_state,
          expiresAt: replay.rows[0].expires_at,
          existing: true,
        };
      }

      // A different request cannot create a parallel active verification.
      const active = await client.query<{
        case_id: string;
        attempt_id: string;
        attempt_state: string;
        expires_at: Date;
      }>(
        `SELECT c.id AS case_id, a.id AS attempt_id, a.state AS attempt_state, a.expires_at
           FROM verification.identity_cases c
           JOIN verification.verification_attempts a ON a.case_id = c.id
          WHERE c.account_id = $1 AND c.state NOT IN ('failed','expired','canceled')
          ORDER BY a.created_at DESC LIMIT 1`,
        [accountId],
      );
      if (active.rows[0] !== undefined) {
        await client.query('COMMIT');
        return {
          caseId: active.rows[0].case_id,
          attemptId: active.rows[0].attempt_id,
          attemptState: active.rows[0].attempt_state,
          expiresAt: active.rows[0].expires_at,
          existing: true,
        };
      }

      const caseId = randomUUID();
      const attemptId = randomUUID();
      const expiresAt = new Date(now.getTime() + 15 * 60_000);
      await client.query(
        `INSERT INTO verification.identity_cases
           (id, account_id, state, age_assurance_state, version, created_at, updated_at)
         VALUES ($1, $2, 'session_created', 'pending', 0, $3, $3)`,
        [caseId, accountId, now],
      );
      await client.query(
        `INSERT INTO verification.verification_attempts
           (id, case_id, provider, session_ref_ciphertext, session_ref_nonce,
            session_ref_key_id, session_ref_digest, state, idempotency_key,
            expires_at, created_at)
         VALUES ($1, $2, $3, 'reserved', 'reserved', 'reserved', $4,
                 'created', $5, $6, $7)`,
        [attemptId, caseId, provider, `reserved:${attemptId}`, idempotencyKey, expiresAt, now],
      );
      await appendAudit(client, accountId, caseId, 'identity.session_reserved', null, now);
      await client.query('COMMIT');
      return {
        caseId,
        attemptId,
        attemptState: 'created',
        expiresAt,
        existing: false,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSession(
    attemptId: string,
    encrypted: { ciphertext: string; nonce: string; keyId: string; digest: string },
    expiresAt: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ case_id: string }>(
        `UPDATE verification.verification_attempts
            SET session_ref_ciphertext=$1, session_ref_nonce=$2,
                session_ref_key_id=$3, session_ref_digest=$4,
                state='pending', expires_at=$5
          WHERE id=$6 AND state IN ('created','failed')
          RETURNING case_id`,
        [
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.keyId,
          encrypted.digest,
          expiresAt,
          attemptId,
        ],
      );
      if (result.rows[0] === undefined) throw new Error('verification_attempt_not_reservable');
      await client.query(
        `UPDATE verification.identity_cases
            SET state='pending', age_assurance_state='pending',
                version=version+1, updated_at=now()
          WHERE id=$1 AND state IN ('session_created','retryable','failed')`,
        [result.rows[0].case_id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markSessionFailure(caseId: string, attemptId: string, now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE verification.verification_attempts SET state='failed' WHERE id=$1 AND state='created'`,
        [attemptId],
      );
      await client.query(
        `UPDATE verification.identity_cases
            SET state='retryable', age_assurance_state='unverified', version=version+1, updated_at=$2
          WHERE id=$1 AND state='session_created'`,
        [caseId, now],
      );
      await appendAudit(
        client,
        null,
        caseId,
        'identity.session_failed',
        'PROVIDER_UNAVAILABLE',
        now,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async status(accountId: string): Promise<VerificationStatusRow> {
    const result = await this.pool.query<VerificationStatusRow>(
      `SELECT
         COALESCE((SELECT state FROM verification.identity_cases
                    WHERE account_id=$1 ORDER BY updated_at DESC LIMIT 1), 'not_started') AS identity,
         COALESCE((SELECT age_assurance_state FROM verification.identity_cases
                    WHERE account_id=$1 ORDER BY updated_at DESC LIMIT 1), 'unverified') AS age_assurance,
         COALESCE((SELECT state FROM verification.membership_cases
                    WHERE account_id=$1 AND state <> 'withdrawn'
                    ORDER BY updated_at DESC LIMIT 1), 'not_applied') AS membership,
         COALESCE((SELECT a.state FROM verification.membership_appeals a
                    JOIN verification.membership_cases m ON m.id=a.membership_case_id
                    WHERE m.account_id=$1 ORDER BY a.created_at DESC LIMIT 1), 'none') AS appeal`,
      [accountId],
    );
    return (
      first(result) ?? {
        identity: 'not_started',
        age_assurance: 'unverified',
        membership: 'not_applied',
        appeal: 'none',
      }
    );
  }

  async claimProviderEvent(
    provider: string,
    eventId: string,
    digest: string,
    occurredAt: Date,
    now: Date,
    leaseMs = 60_000,
  ): Promise<ProviderEventClaim> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{
        payload_digest: string;
        status: string;
        next_retry_at: Date | null;
        lease_until: Date | null;
      }>(
        `SELECT payload_digest, status, next_retry_at, lease_until
           FROM verification.provider_events
          WHERE provider=$1 AND provider_event_id=$2 FOR UPDATE`,
        [provider, eventId],
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        if (current.payload_digest !== digest) {
          await client.query(
            `UPDATE verification.provider_events
                SET status='conflict', processing_token=NULL, lease_until=NULL,
                    last_error_safe='provider_event_digest_conflict'
              WHERE provider=$1 AND provider_event_id=$2`,
            [provider, eventId],
          );
          await client.query('COMMIT');
          return { outcome: 'conflict' };
        }
        if (current.status === 'conflict') {
          await client.query('COMMIT');
          return { outcome: 'conflict' };
        }
        if (current.status === 'processed' || current.status === 'ignored') {
          await client.query('COMMIT');
          return { outcome: 'processed' };
        }
        if (
          current.status === 'processing' &&
          current.lease_until !== null &&
          current.lease_until.getTime() > now.getTime()
        ) {
          await client.query('COMMIT');
          return { outcome: 'in_progress' };
        }
        if (
          current.status === 'retryable' &&
          current.next_retry_at !== null &&
          current.next_retry_at.getTime() > now.getTime()
        ) {
          await client.query('COMMIT');
          return { outcome: 'retry_later' };
        }
        const processingToken = randomUUID();
        await client.query(
          `UPDATE verification.provider_events
              SET status='processing', attempts=attempts+1, received_at=$1,
                  next_retry_at=NULL, lease_until=$2, processing_token=$3
            WHERE provider=$4 AND provider_event_id=$5`,
          [now, new Date(now.getTime() + leaseMs), processingToken, provider, eventId],
        );
        await client.query('COMMIT');
        return { outcome: 'retry_claimed', processingToken };
      }

      const processingToken = randomUUID();
      await client.query(
        `INSERT INTO verification.provider_events
           (id, provider, provider_event_id, payload_digest, occurred_at,
            received_at, status, attempts, lease_until, processing_token)
         VALUES ($1,$2,$3,$4,$5,$6,'processing',1,$7,$8)`,
        [
          randomUUID(),
          provider,
          eventId,
          digest,
          occurredAt,
          now,
          new Date(now.getTime() + leaseMs),
          processingToken,
        ],
      );
      await client.query('COMMIT');
      return { outcome: 'claimed', processingToken };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeProviderEvent(
    provider: string,
    eventId: string,
    processingToken: string,
    status: 'processed' | 'ignored',
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE verification.provider_events
          SET status=$1, processed_at=$2, lease_until=NULL, next_retry_at=NULL,
              processing_token=NULL, last_error_safe=NULL
        WHERE provider=$3 AND provider_event_id=$4
          AND status='processing' AND processing_token=$5`,
      [status, now, provider, eventId, processingToken],
    );
    return result.rowCount === 1;
  }

  async failProviderEvent(
    provider: string,
    eventId: string,
    processingToken: string,
    safeError = 'provider_event_processing_failed',
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE verification.provider_events
          SET status='retryable', last_error_safe=$1, next_retry_at=$2,
              lease_until=NULL, processing_token=NULL
        WHERE provider=$3 AND provider_event_id=$4
          AND status='processing' AND processing_token=$5`,
      [
        safeError.slice(0, 120),
        new Date(now.getTime() + 30_000),
        provider,
        eventId,
        processingToken,
      ],
    );
    return result.rowCount === 1;
  }

  /** Serializes all webhook side effects for one identity case. */
  async withCaseLock<T>(caseId: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [caseId]);
    try {
      return await work();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [caseId]);
      client.release();
    }
  }

  async identityCase(caseId: string): Promise<IdentityCaseSnapshot | null> {
    const result = await this.pool.query<{
      state: string;
      age_assurance_state: string;
      last_provider_occurred_at: Date | null;
      last_provider_event_id: string | null;
    }>(
      `SELECT state, age_assurance_state, last_provider_occurred_at, last_provider_event_id
         FROM verification.identity_cases WHERE id=$1`,
      [caseId],
    );
    const found = first(result);
    return found === null
      ? null
      : {
          state: found.state,
          ageAssuranceState: found.age_assurance_state,
          lastProviderOccurredAt: found.last_provider_occurred_at,
          lastProviderEventId: found.last_provider_event_id,
        };
  }

  async updateIdentity(
    caseId: string,
    state: string,
    ageState: string,
    occurredAt: Date,
    eventId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `WITH changed AS (
         UPDATE verification.identity_cases
            SET state=$1, age_assurance_state=$2, version=version+1, updated_at=now(),
                last_provider_occurred_at=$3, last_provider_event_id=$4,
                verified_at=CASE WHEN $1='verified' THEN COALESCE(verified_at, now()) ELSE verified_at END
          WHERE id=$5 AND (
            last_provider_occurred_at IS NULL OR last_provider_occurred_at < $3 OR
            (last_provider_occurred_at = $3 AND COALESCE(last_provider_event_id, '') < $4)
          )
          RETURNING id
       )
       UPDATE verification.verification_attempts a
          SET state=CASE WHEN $1='needs_review' THEN 'processing' ELSE $1 END
         FROM changed
        WHERE a.case_id=changed.id AND a.state <> 'redacted'`,
      [state, ageState, occurredAt, eventId, caseId],
    );
    return result.rowCount === 1;
  }

  async findCaseBySessionDigest(
    provider: string,
    sessionDigest: string,
  ): Promise<{ caseId: string; accountId: string } | null> {
    const result = await this.pool.query<{ case_id: string; account_id: string }>(
      `SELECT a.case_id, c.account_id
         FROM verification.verification_attempts a
         JOIN verification.identity_cases c ON c.id=a.case_id
        WHERE a.provider=$1 AND a.session_ref_digest=$2 AND a.state <> 'redacted'`,
      [provider, sessionDigest],
    );
    const found = first(result);
    return found === null ? null : { caseId: found.case_id, accountId: found.account_id };
  }

  async bindSubject(
    provider: string,
    subjectDigest: string,
    accountId: string,
  ): Promise<'bound' | 'same' | 'collision'> {
    const existing = await this.pool.query<{ account_id: string }>(
      `SELECT account_id FROM verification.identity_bindings
        WHERE provider=$1 AND subject_digest=$2`,
      [provider, subjectDigest],
    );
    if (existing.rows[0] !== undefined)
      return existing.rows[0].account_id === accountId ? 'same' : 'collision';
    try {
      await this.pool.query(
        `INSERT INTO verification.identity_bindings
           (id,provider,subject_digest,account_id,state,created_at)
         VALUES ($1,$2,$3,$4,'active',now())`,
        [randomUUID(), provider, subjectDigest, accountId],
      );
      return 'bound';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.pool.query<{ account_id: string }>(
        `SELECT account_id FROM verification.identity_bindings
          WHERE provider=$1 AND subject_digest=$2`,
        [provider, subjectDigest],
      );
      return raced.rows[0]?.account_id === accountId ? 'same' : 'collision';
    }
  }

  async insertMembership(
    accountId: string,
    policyId: string,
    revision: number,
    statementCategory: 'community_participation' | 'safety_commitment',
    now: Date,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [accountId]);
      const policy = await client.query<{ content_hash: string }>(
        `SELECT content_hash FROM verification.membership_policies
          WHERE id=$1 AND revision=$2 AND status='approved'
            AND effective_from <= $3 AND effective_until > $3`,
        [policyId, revision, now],
      );
      if (policy.rows[0] === undefined) throw new Error('membership_policy_unavailable');
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM verification.membership_cases
          WHERE account_id=$1 AND state <> 'withdrawn' ORDER BY updated_at DESC LIMIT 1`,
        [accountId],
      );
      if (existing.rows[0] !== undefined) {
        await client.query('COMMIT');
        return existing.rows[0].id;
      }
      const caseId = randomUUID();
      await client.query(
        `INSERT INTO verification.membership_cases
           (id,account_id,policy_id,policy_revision,policy_content_hash,
            statement_category,consented_at,state,version,submitted_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'submitted',0,$7,$7,$7)`,
        [
          caseId,
          accountId,
          policyId,
          revision,
          policy.rows[0].content_hash,
          statementCategory,
          now,
        ],
      );
      await appendAudit(client, accountId, caseId, 'membership.application_submitted', null, now);
      await client.query('COMMIT');
      return caseId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reviewMembership(
    caseId: string,
    reviewer: string,
    decision: 'approved' | 'rejected',
    reason: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ state: string; account_id: string }>(
        `SELECT state, account_id FROM verification.membership_cases WHERE id=$1 FOR UPDATE`,
        [caseId],
      );
      const current = locked.rows[0];
      if (current === undefined) throw new Error('membership_case_not_found');
      if (current.state === decision) {
        await client.query('COMMIT');
        return;
      }
      if (!['submitted', 'under_review'].includes(current.state))
        throw new Error('invalid_membership_review_state');
      await client.query(
        `UPDATE verification.membership_cases
            SET state=$1, version=version+1, decided_at=now(), updated_at=now()
          WHERE id=$2`,
        [decision, caseId],
      );
      await client.query(
        `INSERT INTO verification.membership_reviews
           (id,membership_case_id,reviewer_principal,decision,reason_code,created_at)
         VALUES ($1,$2,$3,$4,$5,now())`,
        [randomUUID(), caseId, reviewer, decision, reason],
      );
      await appendAudit(
        client,
        current.account_id,
        caseId,
        'membership.reviewed',
        reason,
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

  async createAppeal(
    accountId: string,
    category: string,
    encrypted: { ciphertext: string; nonce: string; keyId: string },
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [accountId]);
      const membership = await client.query<{ id: string }>(
        `SELECT id FROM verification.membership_cases
          WHERE account_id=$1 AND state='rejected' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [accountId],
      );
      if (membership.rows[0] === undefined)
        throw new Error('membership_appeal_requires_rejected_case');
      const open = await client.query<{ id: string }>(
        `SELECT id FROM verification.membership_appeals
          WHERE membership_case_id=$1 AND state IN ('submitted','under_review') LIMIT 1`,
        [membership.rows[0].id],
      );
      if (open.rows[0] !== undefined) {
        await client.query('COMMIT');
        return open.rows[0].id;
      }
      const appealId = randomUUID();
      await client.query(
        `INSERT INTO verification.membership_appeals
           (id,membership_case_id,category,statement_ciphertext,statement_nonce,
            statement_key_id,state,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'submitted',now())`,
        [
          appealId,
          membership.rows[0].id,
          category,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.keyId,
        ],
      );
      await appendAudit(
        client,
        accountId,
        membership.rows[0].id,
        'membership.appeal_submitted',
        null,
        new Date(),
      );
      await client.query('COMMIT');
      return appealId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reviewAppeal(
    appealId: string,
    reviewer: string,
    decision: 'upheld' | 'overturned',
    reason: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const appeal = await client.query<{
        state: string;
        membership_case_id: string;
        account_id: string;
      }>(
        `SELECT a.state, a.membership_case_id, m.account_id
           FROM verification.membership_appeals a
           JOIN verification.membership_cases m ON m.id=a.membership_case_id
          WHERE a.id=$1 FOR UPDATE OF a, m`,
        [appealId],
      );
      const current = appeal.rows[0];
      if (current === undefined) throw new Error('membership_appeal_not_found');
      if (current.state === decision) {
        await client.query('COMMIT');
        return;
      }
      if (!['submitted', 'under_review'].includes(current.state))
        throw new Error('invalid_membership_appeal_state');
      await client.query(
        `UPDATE verification.membership_appeals
            SET state=$1, reviewer_principal=$2, reason_code=$3, decided_at=now()
          WHERE id=$4`,
        [decision, reviewer, reason, appealId],
      );
      if (decision === 'overturned') {
        await client.query(
          `UPDATE verification.membership_cases
              SET state='approved', version=version+1, decided_at=now(), updated_at=now()
            WHERE id=$1 AND state='rejected'`,
          [current.membership_case_id],
        );
      }
      await appendAudit(
        client,
        current.account_id,
        current.membership_case_id,
        'membership.appeal_reviewed',
        reason,
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

  async requestRedaction(accountId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [accountId]);
      const open = await client.query<{ id: string; state: string; legal_hold: boolean }>(
        `SELECT id,state,legal_hold FROM verification.redaction_requests
          WHERE account_id=$1 AND state IN ('requested','under_review','held') LIMIT 1`,
        [accountId],
      );
      if (open.rows[0] !== undefined) {
        if (open.rows[0].state === 'held' || open.rows[0].legal_hold) {
          await appendAudit(
            client,
            accountId,
            null,
            'privacy.redaction_blocked_by_legal_hold',
            'LEGAL_HOLD_ACTIVE',
            new Date(),
          );
        }
        await client.query('COMMIT');
        return open.rows[0].id;
      }
      const requestId = randomUUID();
      await client.query(
        `INSERT INTO verification.redaction_requests
           (id,account_id,state,legal_hold,requested_at)
         VALUES ($1,$2,'requested',false,now())`,
        [requestId, accountId],
      );
      await appendAudit(client, accountId, null, 'privacy.redaction_requested', null, new Date());
      await client.query('COMMIT');
      return requestId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function appendAudit(
  client: PoolClient,
  accountId: string | null,
  caseId: string | null,
  eventType: string,
  reasonCode: string | null,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO verification.audit_events
       (account_id,case_id,event_type,reason_code,created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [accountId, caseId, eventType, reasonCode, now],
  );
}
