import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
type MediaPurpose = 'profile_avatar' | 'profile_gallery';
type MediaState =
  | 'reserved'
  | 'uploaded'
  | 'scanning'
  | 'sanitizing'
  | 'clean'
  | 'rejected'
  | 'retryable'
  | 'deleted'
  | 'held';
type MediaJobStage = 'scan' | 'sanitize' | 'publish';
type MediaSafeError = string;
type MediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface MediaAssetRow {
  assetId: string;
  ownerId: string;
  purpose: MediaPurpose;
  state: MediaState;
  detectedType: MediaType | null;
  sha256: string | null;
  retentionState: 'active' | 'deleted' | 'held';
  quarantineKeyDigest: string;
  declaredSize: number;
  declaredType: string | null;
}

export interface MediaStatusRow extends MediaAssetRow {
  rendition: {
    variant: 'clean';
    contentType: MediaType;
    width: number;
    height: number;
    bytes: number;
  } | null;
}

function first<T>(result: { rows: T[] }): T | null {
  return result.rows[0] ?? null;
}

/** PostgreSQL-owned media lifecycle. Object bytes and access tokens never enter this repository. */
export class PgMediaRepository {
  constructor(private readonly pool: Pool) {}

  async createIntent(input: {
    assetId: string;
    ownerId: string;
    purpose: MediaPurpose;
    declaredSize: number;
    declaredType: string | null;
    idempotencyDigest: string;
    quarantineKeyDigest: string;
    payloadDigest: string;
    expiresAt: Date;
    now?: Date;
  }): Promise<{
    created: boolean;
    assetId: string;
    state: MediaState;
    quarantineKeyDigest: string;
    expiresAt: Date;
  }> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.ownerId]);
      const existing = await client.query<{
        asset_id: string;
        state: MediaState;
        quarantine_key_digest: string;
        payload_digest: string;
        expires_at: Date;
      }>(
        `SELECT i.asset_id, a.state, i.quarantine_key_digest, i.payload_digest
           FROM media.upload_intents i JOIN media.assets a ON a.id=i.asset_id
          WHERE i.owner_id=$1 AND i.idempotency_digest=$2 FOR UPDATE`,
        [input.ownerId, input.idempotencyDigest],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (prior.payload_digest !== input.payloadDigest)
          throw new Error('media_idempotency_conflict');
        await client.query('COMMIT');
        return {
          created: false,
          assetId: prior.asset_id,
          state: prior.state,
          quarantineKeyDigest: prior.quarantine_key_digest,
          expiresAt: prior.expires_at,
        };
      }
      await client.query(
        `INSERT INTO media.assets
           (id,owner_id,purpose,state,declared_size,declared_content_type,version,retention_state,created_at,updated_at)
         VALUES ($1,$2,$3,'reserved',$4,$5,1,'active',$6,$6)`,
        [input.assetId, input.ownerId, input.purpose, input.declaredSize, input.declaredType, now],
      );
      await client.query(
        `INSERT INTO media.upload_intents
           (id,asset_id,owner_id,idempotency_digest,quarantine_key_digest,payload_digest,expires_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          input.assetId,
          input.ownerId,
          input.idempotencyDigest,
          input.quarantineKeyDigest,
          input.payloadDigest,
          input.expiresAt,
          now,
        ],
      );
      await client.query('COMMIT');
      return {
        created: true,
        assetId: input.assetId,
        state: 'reserved',
        quarantineKeyDigest: input.quarantineKeyDigest,
        expiresAt: input.expiresAt,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeIntent(input: {
    assetId: string;
    ownerId: string;
    completeIdempotencyDigest: string;
    completePayloadDigest: string;
    detectedSize: number;
    detectedType: MediaType;
    sha256: string;
    now?: Date;
  }): Promise<{ state: MediaState; jobId: string | null }> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<{
        state: MediaState;
        expires_at: Date;
        complete_idempotency_digest: string | null;
        complete_payload_digest: string | null;
      }>(
        `SELECT a.state, i.expires_at, i.complete_idempotency_digest, i.complete_payload_digest FROM media.assets a
          JOIN media.upload_intents i ON i.asset_id=a.id
         WHERE a.id=$1 AND a.owner_id=$2 FOR UPDATE`,
        [input.assetId, input.ownerId],
      );
      const current = row.rows[0];
      if (current === undefined) throw new Error('media_intent_not_found');
      if (
        current.complete_idempotency_digest !== null &&
        (current.complete_idempotency_digest !== input.completeIdempotencyDigest ||
          current.complete_payload_digest !== input.completePayloadDigest)
      ) {
        throw new Error('media_idempotency_conflict');
      }
      if (
        current.state === 'uploaded' ||
        current.state === 'scanning' ||
        current.state === 'sanitizing'
      ) {
        const job = await client.query<{ id: string }>(
          `SELECT id FROM media.processing_jobs WHERE asset_id=$1 AND stage='scan'`,
          [input.assetId],
        );
        await client.query('COMMIT');
        return { state: current.state, jobId: job.rows[0]?.id ?? null };
      }
      if (current.state !== 'reserved') throw new Error('media_intent_not_completable');
      if (current.expires_at.getTime() <= now.getTime()) throw new Error('media_intent_expired');
      await client.query(
        `UPDATE media.assets SET state='uploaded', detected_type=$1, sha256=$2,
             updated_at=$3, version=version+1
          WHERE id=$4 AND state='reserved'`,
        [input.detectedType, input.sha256, now, input.assetId],
      );
      await client.query(
        `UPDATE media.upload_intents SET completed_at=$1,complete_idempotency_digest=$2,complete_payload_digest=$3 WHERE asset_id=$4`,
        [now, input.completeIdempotencyDigest, input.completePayloadDigest, input.assetId],
      );
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO media.processing_jobs
           (id,asset_id,stage,attempt,status,created_at,updated_at)
         VALUES ($1,$2,'scan',0,'queued',$3,$3)`,
        [jobId, input.assetId, now],
      );
      await client.query('COMMIT');
      return { state: 'uploaded', jobId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findCompleteReplay(input: {
    assetId: string;
    ownerId: string;
    completeIdempotencyDigest: string;
  }): Promise<{ state: MediaState; jobId: string | null } | null> {
    const result = await this.pool.query<{ state: MediaState; job_id: string | null }>(
      `SELECT a.state,j.id AS job_id FROM media.assets a JOIN media.upload_intents i ON i.asset_id=a.id LEFT JOIN media.processing_jobs j ON j.asset_id=a.id AND j.stage='scan' WHERE a.id=$1 AND a.owner_id=$2 AND i.complete_idempotency_digest=$3`,
      [input.assetId, input.ownerId, input.completeIdempotencyDigest],
    );
    const row = result.rows[0];
    return row === undefined ? null : { state: row.state, jobId: row.job_id };
  }

  /** Make a retryable durable job immediately eligible for a replay wake-up. */
  async wakeJob(jobId: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE media.processing_jobs SET next_retry_at=$2,updated_at=$2
         WHERE id=$1 AND status='retryable'`,
      [jobId, now],
    );
    return result.rowCount === 1;
  }

  async claimJob(input: { workerId: string; now: Date; leaseSeconds: number }): Promise<{
    jobId: string;
    assetId: string;
    stage: MediaJobStage;
    leaseToken: string;
    quarantineKeyDigest: string;
  } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        id: string;
        asset_id: string;
        stage: MediaJobStage;
        quarantine_key_digest: string;
      }>(
        `SELECT j.id,j.asset_id,j.stage,i.quarantine_key_digest
           FROM media.processing_jobs j JOIN media.upload_intents i ON i.asset_id=j.asset_id
          WHERE (j.status='queued' OR (j.status='claimed' AND j.lease_until <= $1)
                 OR (j.status='retryable' AND COALESCE(j.next_retry_at,$1) <= $1))
          ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [input.now],
      );
      const job = selected.rows[0];
      if (job === undefined) {
        await client.query('COMMIT');
        return null;
      }
      const leaseToken = randomUUID();
      await client.query(
        `UPDATE media.processing_jobs SET status='claimed',attempt=attempt+1,lease_token=$1,
           lease_until=$2,worker_id=$3,next_retry_at=NULL,updated_at=$4 WHERE id=$5`,
        [
          leaseToken,
          new Date(input.now.getTime() + input.leaseSeconds * 1000),
          input.workerId,
          input.now,
          job.id,
        ],
      );
      await client.query('COMMIT');
      return {
        jobId: job.id,
        assetId: job.asset_id,
        stage: job.stage,
        leaseToken,
        quarantineKeyDigest: job.quarantine_key_digest,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finishJob(input: {
    jobId: string;
    leaseToken: string;
    state: Extract<MediaState, 'clean' | 'rejected' | 'retryable'>;
    errorCode?: MediaSafeError;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ asset_id: string }>(
        `UPDATE media.processing_jobs SET status=CASE WHEN $1='retryable' THEN 'retryable' ELSE CASE WHEN $1='clean' THEN 'completed' ELSE 'failed' END END,
            safe_error=$2,lease_token=NULL,lease_until=NULL,next_retry_at=CASE WHEN $1='retryable' THEN $3::timestamptz + interval '5 seconds' ELSE NULL END,updated_at=$3
          WHERE id=$4 AND status='claimed' AND lease_token=$5 RETURNING asset_id`,
        [input.state, input.errorCode ?? null, now, input.jobId, input.leaseToken],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE media.assets SET state=$1,updated_at=$2,version=version+1 WHERE id=$3 AND state NOT IN ('deleted','held')`,
        [input.state, now, row.asset_id],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async advanceStage(input: {
    jobId: string;
    leaseToken: string;
    assetId: string;
    to: 'scanning' | 'sanitizing';
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const from = input.to === 'scanning' ? ['uploaded', 'retryable'] : ['scanning'];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await client.query(
        `SELECT id FROM media.processing_jobs WHERE id=$1 AND lease_token=$2 AND status='claimed' FOR UPDATE`,
        [input.jobId, input.leaseToken],
      );
      if (job.rows[0] === undefined) {
        await client.query('ROLLBACK');
        return false;
      }
      const result = await client.query(
        `UPDATE media.assets SET state=$1,updated_at=$2,version=version+1 WHERE id=$3 AND state = ANY($4::text[]) RETURNING id`,
        [input.to, now, input.assetId, from],
      );
      await client.query('COMMIT');
      return result.rows.length === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async asset(assetId: string): Promise<MediaAssetRow | null> {
    const result = await this.pool.query<MediaAssetRow & { quarantine_key_digest: string }>(
      `SELECT a.id AS "assetId",a.owner_id AS "ownerId",a.purpose,a.state,a.declared_size::int AS "declaredSize",a.declared_content_type AS "declaredType",a.detected_type AS "detectedType",a.sha256,a.retention_state AS "retentionState",i.quarantine_key_digest AS "quarantineKeyDigest"
         FROM media.assets a JOIN media.upload_intents i ON i.asset_id=a.id WHERE a.id=$1`,
      [assetId],
    );
    return first(result);
  }

  async status(assetId: string): Promise<MediaStatusRow | null> {
    const result = await this.pool.query<
      MediaStatusRow & {
        quarantine_key_digest: string;
        content_type: MediaType;
        width: number;
        height: number;
        bytes: number;
        variant: 'clean';
      }
    >(
      `SELECT a.id AS "assetId",a.owner_id AS "ownerId",a.purpose,a.state,a.declared_size::int AS "declaredSize",a.declared_content_type AS "declaredType",a.detected_type AS "detectedType",a.sha256,a.retention_state AS "retentionState",i.quarantine_key_digest AS "quarantineKeyDigest",
              r.variant,r.content_type,r.width,r.height,r.bytes
         FROM media.assets a JOIN media.upload_intents i ON i.asset_id=a.id
         LEFT JOIN media.renditions r ON r.asset_id=a.id AND r.variant='clean' WHERE a.id=$1`,
      [assetId],
    );
    const row = first(result);
    if (row === null) return null;
    return {
      ...row,
      rendition:
        row.variant === undefined
          ? null
          : {
              variant: row.variant,
              contentType: row.content_type,
              width: row.width,
              height: row.height,
              bytes: row.bytes,
            },
    };
  }

  async markDeleted(
    assetId: string,
    actorId: string,
    now = new Date(),
  ): Promise<'deleted' | 'held' | 'not_found'> {
    const current = await this.pool.query<{
      state: MediaState;
      retention_state: 'active' | 'deleted' | 'held';
    }>(`SELECT state,retention_state FROM media.assets WHERE id=$1 AND owner_id=$2`, [
      assetId,
      actorId,
    ]);
    if (current.rows[0] === undefined) return 'not_found';
    if (current.rows[0].state === 'held' || current.rows[0].retention_state === 'held')
      return 'held';
    if (current.rows[0].state === 'deleted') return 'deleted';
    const result = await this.pool.query<{ retention_state: 'active' | 'held' }>(
      `UPDATE media.assets SET state=CASE WHEN retention_state='held' THEN 'held' ELSE 'deleted' END,
          retention_state=CASE WHEN retention_state='held' THEN 'held' ELSE 'deleted' END,
          deleted_at=CASE WHEN retention_state='held' THEN deleted_at ELSE $2 END,updated_at=$2,version=version+1
        WHERE id=$1 AND owner_id=$3 AND state <> 'deleted' RETURNING retention_state`,
      [assetId, now, actorId],
    );
    const state = result.rows[0]?.retention_state;
    return state === undefined ? 'not_found' : state === 'held' ? 'held' : 'deleted';
  }

  async placeLegalHold(assetId: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE media.assets SET state='held',retention_state='held',legal_hold_at=$2,updated_at=$2,version=version+1 WHERE id=$1 AND state NOT IN ('deleted','held')`,
      [assetId, now],
    );
    return result.rowCount === 1;
  }

  async recordAccess(
    assetId: string | null,
    viewerId: string | null,
    purpose: MediaPurpose,
    outcome: 'allowed' | 'denied',
    reasonCode: string,
    now = new Date(),
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO media.access_audit(asset_id,viewer_id,purpose,outcome,reason_code,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [assetId, viewerId, purpose, outcome, reasonCode, now],
    );
  }

  async publishRendition(input: {
    jobId: string;
    leaseToken: string;
    assetId: string;
    renditionId: string;
    cleanKeyDigest: string;
    contentType: MediaType;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
    sanitizerVersion: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `SELECT id FROM media.processing_jobs WHERE id=$1 AND lease_token=$2 AND status='claimed' FOR UPDATE`,
        [input.jobId, input.leaseToken],
      );
      if (claimed.rows[0] === undefined) {
        await client.query('ROLLBACK');
        return false;
      }
      const assetUpdated = await client.query(
        `UPDATE media.assets SET state='clean',updated_at=$1,version=version+1 WHERE id=$2 AND state='sanitizing'`,
        [now, input.assetId],
      );
      if (assetUpdated.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO media.renditions(id,asset_id,variant,clean_key_digest,content_type,width,height,bytes,sha256,sanitizer_version,created_at) VALUES ($1,$2,'clean',$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(asset_id,variant) DO UPDATE SET clean_key_digest=EXCLUDED.clean_key_digest,content_type=EXCLUDED.content_type,width=EXCLUDED.width,height=EXCLUDED.height,bytes=EXCLUDED.bytes,sha256=EXCLUDED.sha256,sanitizer_version=EXCLUDED.sanitizer_version`,
        [
          input.renditionId,
          input.assetId,
          input.cleanKeyDigest,
          input.contentType,
          input.width,
          input.height,
          input.bytes,
          input.sha256,
          input.sanitizerVersion,
          now,
        ],
      );
      const jobUpdated = await client.query(
        `UPDATE media.processing_jobs SET status='completed',lease_token=NULL,lease_until=NULL,updated_at=$1 WHERE id=$2 AND lease_token=$3`,
        [now, input.jobId, input.leaseToken],
      );
      if (jobUpdated.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
