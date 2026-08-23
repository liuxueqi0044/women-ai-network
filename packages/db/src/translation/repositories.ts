import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { aesGcmDecrypt, aesGcmEncrypt, hmacDigest } from '../crypto.js';
import {
  translationCacheKeySchema,
  translationProviderOutputSchema,
  type TranslationCacheKey,
  type TranslationConsent,
  type TranslationProviderOutput,
  type TranslationRepositoryPort,
  type TranslationResult,
  type TranslationFallbackResponse,
  type TranslationState,
  type TranslationTask,
} from '@wai/contracts';

const PUBLIC_TRANSLATION_BINDING = '00000000-0000-4000-8000-000000000000';

export interface TranslationKeyring {
  keyId: string;
  key: Buffer;
  keys?: ReadonlyMap<string, Buffer>;
  hmacKey?: Buffer;
}

export class TranslationIdempotencyConflictError extends Error {
  constructor() {
    super('translation idempotency key payload conflict');
    this.name = 'TranslationIdempotencyConflictError';
  }
}

type TaskRow = {
  id: string;
  owner_id: string;
  source_kind: TranslationCacheKey['source_kind'];
  letter_id: string;
  source_revision_id: string;
  source_revision: number;
  source_hash: string;
  source_locale: string;
  target_locale: string;
  provider_id: string;
  provider_version: string;
  consent_id: string | null;
  consent_provider_version: string | null;
  consent_processing_region: string | null;
  consent_retention_policy: 'zero' | 'ephemeral' | 'bounded' | null;
  consent_retention_seconds: number | null;
  state: TranslationState;
  request_digest: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  lease_until: Date | null;
  next_retry_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
};
type ConsentRow = Omit<TranslationConsent, 'expires_at' | 'revoked_at' | 'created_at'> & {
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
};
type FrozenTask = Omit<
  TranslationTask,
  'createdAt' | 'updatedAt' | 'nextRetryAt' | 'leaseUntil'
> & {
  createdAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
  leaseUntil: string | null;
};
type FrozenFallback = {
  source_locale: string;
  target_locale: string;
  title_ciphertext: string;
  title_nonce: string;
  body_ciphertext: string;
  body_nonce: string;
  key_id: string;
};

export class PgTranslationRepository implements TranslationRepositoryPort {
  private readonly encryptionKeys: ReadonlyMap<string, Buffer>;
  private readonly activeKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(
    private readonly pool: Pool,
    private readonly keyring: TranslationKeyring,
  ) {
    if (keyring.key.length !== 32) throw new Error('translation_key_invalid');
    this.activeKey = keyring.key;
    this.encryptionKeys = keyring.keys ?? new Map([[keyring.keyId, keyring.key]]);
    this.hmacKey = keyring.hmacKey ?? keyring.key;
  }

  async listDueWakeups(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ taskId: string; attempt: number; nextRetryAt: Date }>> {
    const result = await this.pool.query<{ task_id: string; attempt: number; next_retry_at: Date }>(
      `SELECT task_id,attempt,next_retry_at
         FROM translation.retry_wakeups
        WHERE enqueued_at IS NULL AND next_retry_at <= $1
        ORDER BY next_retry_at,task_id
        LIMIT $2`,
      [input.now, Math.max(1, Math.min(100, input.limit))],
    );
    return result.rows.map((row) => ({
      taskId: row.task_id,
      attempt: row.attempt,
      nextRetryAt: row.next_retry_at,
    }));
  }

  async markWakeupEnqueued(input: {
    taskId: string;
    attempt: number;
    enqueuedAt: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE translation.retry_wakeups SET enqueued_at=$1
        WHERE task_id=$2 AND attempt=$3 AND enqueued_at IS NULL`,
      [input.enqueuedAt, input.taskId, input.attempt],
    );
    return result.rowCount === 1;
  }

  async reapExpiredLeases(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ taskId: string; attempt: number; nextRetryAt: Date }>> {
    const now = input.now;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const expired = await client.query<{
        id: string;
        attempts: number;
        max_attempts: number;
      }>(
        `SELECT id,attempts,max_attempts
           FROM translation.tasks
          WHERE state='leased' AND lease_until <= $1
          ORDER BY lease_until,id
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [now, Math.max(1, Math.min(100, input.limit))],
      );
      const scheduled: Array<{ taskId: string; attempt: number; nextRetryAt: Date }> = [];
      for (const row of expired.rows) {
        if (row.attempts >= row.max_attempts) {
          await client.query(
            `UPDATE translation.tasks
                SET state='failed',lease_token=NULL,lease_until=NULL,next_retry_at=NULL,
                    last_error_code='LEASE_EXPIRED',updated_at=$1
              WHERE id=$2 AND state='leased' AND lease_until <= $1`,
            [now, row.id],
          );
          await client.query('DELETE FROM translation.retry_wakeups WHERE task_id=$1', [row.id]);
          continue;
        }
        const nextRetryAt = new Date(now.getTime() + retryDelayMs(row.attempts));
        await client.query(
          `UPDATE translation.tasks
              SET state='retry_wait',lease_token=NULL,lease_until=NULL,next_retry_at=$1,
                  last_error_code='LEASE_EXPIRED',updated_at=$2
            WHERE id=$3 AND state='leased' AND lease_until <= $2`,
          [nextRetryAt, now, row.id],
        );
        await client.query(
          `INSERT INTO translation.retry_wakeups(task_id,attempt,next_retry_at,enqueued_at,created_at)
           VALUES ($1,$2,$3,NULL,$4)
           ON CONFLICT (task_id) DO UPDATE
             SET attempt=EXCLUDED.attempt,next_retry_at=EXCLUDED.next_retry_at,enqueued_at=NULL`,
          [row.id, row.attempts, nextRetryAt, now],
        );
        scheduled.push({ taskId: row.id, attempt: row.attempts, nextRetryAt });
      }
      await client.query('COMMIT');
      return scheduled;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async replay(input: {
    ownerId: string;
    requestDigest: string;
    idempotencyKey: string;
  }): Promise<{ task: TranslationTask } | { fallback: TranslationFallbackResponse } | null> {
    const keyDigest = this.digest('idempotency-key', input.idempotencyKey);
    const result = await this.pool.query<{
      payload_digest: string;
      result_json: { task?: FrozenTask; fallback?: FrozenFallback };
    }>(
      `SELECT payload_digest,result_json
         FROM translation.idempotency_keys WHERE owner_id=$1 AND key_digest=$2`,
      [input.ownerId, keyDigest],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.payload_digest !== input.requestDigest) throw new TranslationIdempotencyConflictError();
    if (row.result_json.task !== undefined) return { task: fromFrozenTask(row.result_json.task) };
    const fallback = row.result_json.fallback;
    if (fallback === undefined) throw new Error('translation_replay_invalid');
    const key = this.encryptionKeys.get(fallback.key_id);
    if (key === undefined) throw new Error('translation_key_unavailable');
    const title = aesGcmDecrypt(key, {
      ciphertext: fallback.title_ciphertext,
      nonce: fallback.title_nonce,
    });
    const body = JSON.parse(
      aesGcmDecrypt(key, { ciphertext: fallback.body_ciphertext, nonce: fallback.body_nonce }),
    ) as { paragraphs: string[] };
    return {
      fallback: {
        machine_translated: false,
        source_locale: fallback.source_locale,
        target_locale: fallback.target_locale,
        original: { title, body },
      },
    };
  }

  async saveFallbackReplay(input: {
    ownerId: string;
    requestDigest: string;
    idempotencyKey: string;
    fallback: TranslationFallbackResponse;
  }): Promise<TranslationFallbackResponse> {
    const keyDigest = this.digest('idempotency-key', input.idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${input.ownerId}:${keyDigest}`,
      ]);
      const existing = await client.query<{
        payload_digest: string;
        result_json: { fallback?: FrozenFallback };
      }>(
        `SELECT payload_digest,result_json FROM translation.idempotency_keys WHERE owner_id=$1 AND key_digest=$2 FOR UPDATE`,
        [input.ownerId, keyDigest],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.payload_digest !== input.requestDigest)
          throw new TranslationIdempotencyConflictError();
        await client.query('COMMIT');
        const replay = await this.replay({
          ownerId: input.ownerId,
          requestDigest: input.requestDigest,
          idempotencyKey: input.idempotencyKey,
        });
        if (replay !== null && 'fallback' in replay) return replay.fallback;
        throw new Error('translation_fallback_replay_invalid');
      }
      const title = aesGcmEncrypt(this.activeKey, input.fallback.original.title);
      const body = aesGcmEncrypt(this.activeKey, JSON.stringify(input.fallback.original.body));
      const frozen: FrozenFallback = {
        source_locale: input.fallback.source_locale,
        target_locale: input.fallback.target_locale,
        title_ciphertext: title.ciphertext,
        title_nonce: title.nonce,
        body_ciphertext: body.ciphertext,
        body_nonce: body.nonce,
        key_id: this.keyring.keyId,
      };
      await client.query(
        `INSERT INTO translation.idempotency_keys(owner_id,key_digest,payload_digest,result_json,created_at) VALUES ($1,$2,$3,$4,now())`,
        [input.ownerId, keyDigest, input.requestDigest, JSON.stringify({ fallback: frozen })],
      );
      await client.query('COMMIT');
      return input.fallback;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createOrReplay(input: {
    ownerId: string;
    key: TranslationCacheKey;
    requestDigest: string;
    idempotencyKey: string;
    consent?: {
      id: string;
      providerVersion: string;
      processingRegion: string;
      retentionPolicy: 'zero' | 'ephemeral' | 'bounded';
      retentionSeconds: number;
    };
    now?: Date;
  }): Promise<{ created: boolean; task: TranslationTask }> {
    const now = input.now ?? new Date();
    const key = translationCacheKeySchema.parse(input.key);
    const keyDigest = this.digest('idempotency-key', input.idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${input.ownerId}:${keyDigest}`,
      ]);
      const existing = await client.query<{
        payload_digest: string;
        result_json: { task: FrozenTask };
      }>(
        `SELECT payload_digest,result_json FROM translation.idempotency_keys WHERE owner_id=$1 AND key_digest=$2 FOR UPDATE`,
        [input.ownerId, keyDigest],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (prior.payload_digest !== input.requestDigest)
          throw new TranslationIdempotencyConflictError();
        const replayed = fromFrozenTask(prior.result_json.task);
        await ensureWakeup(client, replayed, now);
        await client.query('COMMIT');
        return { created: false, task: replayed };
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO translation.tasks
          (id,owner_id,source_kind,letter_id,source_revision_id,source_revision,source_hash,source_locale,target_locale,provider_id,provider_version,consent_id,consent_provider_version,consent_processing_region,consent_retention_policy,consent_retention_seconds,state,request_digest,key_digest,attempts,max_attempts,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued',$17,$18,0,3,$19,$19)
         ON CONFLICT (source_kind,letter_id,source_revision_id,source_revision,source_hash,source_locale,target_locale,provider_id,provider_version,consent_id)
         DO NOTHING RETURNING id`,
        [
          randomUUID(),
          input.ownerId,
          key.source_kind,
          key.letter_id,
          key.source_revision_id,
          key.source_revision,
          key.source_hash,
          key.source_locale,
          key.target_locale,
          key.provider_id,
          key.provider_version,
          input.consent?.id ?? PUBLIC_TRANSLATION_BINDING,
          input.consent?.providerVersion ?? null,
          input.consent?.processingRegion ?? null,
          input.consent?.retentionPolicy ?? null,
          input.consent?.retentionSeconds ?? null,
          input.requestDigest,
          keyDigest,
          now,
        ],
      );
      let taskId = inserted.rows[0]?.id;
      if (taskId === undefined) {
        const duplicate = await client.query<{ id: string }>(
          `SELECT id FROM translation.tasks WHERE source_kind=$1 AND letter_id=$2 AND source_revision_id=$3 AND source_revision=$4 AND source_hash=$5 AND source_locale=$6 AND target_locale=$7 AND provider_id=$8 AND provider_version=$9 AND consent_id=$10 FOR UPDATE`,
          [
            key.source_kind,
            key.letter_id,
            key.source_revision_id,
            key.source_revision,
            key.source_hash,
            key.source_locale,
            key.target_locale,
            key.provider_id,
            key.provider_version,
            input.consent?.id ?? PUBLIC_TRANSLATION_BINDING,
          ],
        );
        taskId = duplicate.rows[0]?.id;
      }
      if (taskId === undefined) throw new Error('translation_task_insert_failed');
      const task = await this.loadTask(client, taskId);
      if (task === null) throw new Error('translation_task_missing');
      await ensureWakeup(client, task, now);
      await client.query(
        `INSERT INTO translation.idempotency_keys(owner_id,key_digest,payload_digest,result_json,created_at) VALUES ($1,$2,$3,$4,$5)`,
        [
          input.ownerId,
          keyDigest,
          input.requestDigest,
          JSON.stringify({ task: freezeTask(task) }),
          now,
        ],
      );
      await client.query('COMMIT');
      return { created: inserted.rows[0] !== undefined, task };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(input: {
    workerId: string;
    now: Date;
    leaseSeconds: number;
    taskId?: string;
  }): Promise<TranslationTask | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<TaskRow>(
        `SELECT * FROM translation.tasks
          WHERE ($2::uuid IS NULL OR id=$2) AND (state='queued' OR (state='retry_wait' AND next_retry_at <= $1))
            AND attempts < max_attempts
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [input.now, input.taskId ?? null],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        await client.query('COMMIT');
        return null;
      }
      const leaseToken = randomUUID();
      const leaseUntil = new Date(input.now.getTime() + input.leaseSeconds * 1000);
      const updated = await client.query<TaskRow>(
        `UPDATE translation.tasks SET state='leased',attempts=attempts+1,lease_token=$1,lease_until=$2,next_retry_at=NULL,updated_at=$3
          WHERE id=$4 RETURNING *`,
        [this.digest('lease-token', leaseToken), leaseUntil, input.now, row.id],
      );
      await client.query('DELETE FROM translation.retry_wakeups WHERE task_id=$1', [row.id]);
      await client.query('COMMIT');
      return updated.rows[0] === undefined ? null : toTask(updated.rows[0], leaseToken);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findTask(taskId: string): Promise<TranslationTask | null> {
    const result = await this.pool.query<TaskRow>('SELECT * FROM translation.tasks WHERE id=$1', [
      taskId,
    ]);
    return result.rows[0] === undefined ? null : toTask(result.rows[0]);
  }

  async complete(input: {
    taskId: string;
    leaseToken: string;
    output: TranslationProviderOutput;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const output = translationProviderOutputSchema.parse(input.output);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query<TaskRow>(
        `SELECT * FROM translation.tasks
          WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_until > $3
            AND ((source_kind='public_letter' AND EXISTS (
              SELECT 1 FROM letters.publications p JOIN letters.letters l ON l.id=p.letter_id
               WHERE p.letter_id=translation.tasks.letter_id AND p.revision_id=translation.tasks.source_revision_id AND p.source_hash=translation.tasks.source_hash AND l.state='published'
            )) OR (source_kind='private_letter' AND EXISTS (
              SELECT 1 FROM translation.consents c
               WHERE c.owner_id=translation.tasks.owner_id AND c.letter_id=translation.tasks.letter_id
                 AND c.source_revision_id=translation.tasks.source_revision_id AND c.source_hash=translation.tasks.source_hash
                 AND c.id=translation.tasks.consent_id
                 AND c.provider_id=translation.tasks.provider_id
                 AND c.provider_version=translation.tasks.consent_provider_version
                 AND c.processing_region=translation.tasks.consent_processing_region
                 AND c.retention_policy=translation.tasks.consent_retention_policy
                 AND c.retention_seconds=translation.tasks.consent_retention_seconds
                 AND c.capability='private_translation'
                 AND c.no_training=true AND c.revoked_at IS NULL AND c.expires_at > $3
            ))) FOR UPDATE`,
        [input.taskId, this.digest('lease-token', input.leaseToken), now],
      );
      const row = task.rows[0];
      if (row === undefined) {
        await client.query('ROLLBACK');
        return false;
      }
      if (output.target_locale !== row.target_locale) {
        throw new Error('translation_output_locale_mismatch');
      }
      const title = aesGcmEncrypt(this.activeKey, output.title);
      const body = aesGcmEncrypt(this.activeKey, JSON.stringify({ paragraphs: output.paragraphs }));
      await client.query(
        `INSERT INTO translation.results(task_id,title_ciphertext,title_nonce,body_ciphertext,body_nonce,key_id,result_hash,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          row.id,
          title.ciphertext,
          title.nonce,
          body.ciphertext,
          body.nonce,
          this.keyring.keyId,
          this.digest('result', JSON.stringify(output)),
          now,
        ],
      );
      await client.query(
        `UPDATE translation.tasks SET state='ready',lease_token=NULL,lease_until=NULL,next_retry_at=NULL,last_error_code=NULL,updated_at=$1
          WHERE id=$2 AND state='leased' AND lease_token=$3`,
        [now, row.id, this.digest('lease-token', input.leaseToken)],
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

  async fail(input: {
    taskId: string;
    leaseToken: string;
    errorCode: string;
    now?: Date;
  }): Promise<{ accepted: boolean; state: TranslationState; nextRetryAt: Date | null }> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ attempts: number; max_attempts: number }>(
        `SELECT attempts,max_attempts FROM translation.tasks WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_until > $3 FOR UPDATE`,
        [input.taskId, this.digest('lease-token', input.leaseToken), now],
      );
      const row = current.rows[0];
      if (row === undefined) {
        await client.query('ROLLBACK');
        return { accepted: false, state: 'failed', nextRetryAt: null };
      }
      const terminal = row.attempts >= row.max_attempts;
      const nextRetryAt = terminal ? null : new Date(now.getTime() + retryDelayMs(row.attempts));
      const state: TranslationState = terminal ? 'failed' : 'retry_wait';
      await client.query(
        `UPDATE translation.tasks SET state=$1,lease_token=NULL,lease_until=NULL,next_retry_at=$2,last_error_code=$3,updated_at=$4 WHERE id=$5 AND state='leased' AND lease_token=$6`,
        [
          state,
          nextRetryAt,
          input.errorCode,
          now,
          input.taskId,
          this.digest('lease-token', input.leaseToken),
        ],
      );
      if (state === 'retry_wait') {
        await client.query(
          `INSERT INTO translation.retry_wakeups(task_id,attempt,next_retry_at,enqueued_at,created_at)
           VALUES ($1,$2,$3,NULL,$4)
           ON CONFLICT (task_id) DO UPDATE SET attempt=EXCLUDED.attempt,next_retry_at=EXCLUDED.next_retry_at,enqueued_at=NULL`,
          [input.taskId, row.attempts, nextRetryAt, now],
        );
      } else {
        await client.query('DELETE FROM translation.retry_wakeups WHERE task_id=$1', [
          input.taskId,
        ]);
      }
      await client.query('COMMIT');
      return { accepted: true, state, nextRetryAt };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(input: {
    taskId: string;
    leaseToken: string;
    errorCode: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const result = await this.pool.query(
      `UPDATE translation.tasks
          SET state='cancelled',lease_token=NULL,lease_until=NULL,next_retry_at=NULL,last_error_code=$1,updated_at=$2
        WHERE id=$3 AND state='leased' AND lease_token=$4 AND lease_until > $2`,
      [input.errorCode, now, input.taskId, this.digest('lease-token', input.leaseToken)],
    );
    return result.rowCount === 1;
  }

  async read(input: { taskId: string }): Promise<TranslationResult | null> {
    const result = await this.pool.query<
      TaskRow & {
        title_ciphertext: string;
        title_nonce: string;
        body_ciphertext: string;
        body_nonce: string;
        key_id: string;
        result_hash: string;
        result_created_at: Date;
      }
    >(
      `SELECT t.*,r.title_ciphertext,r.title_nonce,r.body_ciphertext,r.body_nonce,r.key_id,r.result_hash,r.created_at AS result_created_at
         FROM translation.tasks t JOIN translation.results r ON r.task_id=t.id
        WHERE t.id=$1 AND t.state='ready'
          AND ((t.source_kind='public_letter' AND EXISTS (
            SELECT 1 FROM letters.publications p JOIN letters.letters l ON l.id=p.letter_id
             WHERE p.letter_id=t.letter_id AND p.revision_id=t.source_revision_id
               AND p.source_hash=t.source_hash AND l.state='published'
          )) OR (t.source_kind='private_letter' AND EXISTS (
            SELECT 1 FROM translation.consents c
             WHERE c.id=t.consent_id AND c.owner_id=t.owner_id AND c.letter_id=t.letter_id
               AND c.source_revision_id=t.source_revision_id AND c.source_hash=t.source_hash
               AND c.provider_id=t.provider_id AND c.provider_version=t.consent_provider_version
               AND c.processing_region=t.consent_processing_region
               AND c.retention_policy=t.consent_retention_policy
               AND c.retention_seconds=t.consent_retention_seconds
               AND c.revoked_at IS NULL AND c.expires_at > now()
          )))`,
      [input.taskId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const key = this.encryptionKeys.get(row.key_id);
    if (key === undefined) throw new Error('translation_key_unavailable');
    const title = aesGcmDecrypt(key, { ciphertext: row.title_ciphertext, nonce: row.title_nonce });
    const body = JSON.parse(
      aesGcmDecrypt(key, { ciphertext: row.body_ciphertext, nonce: row.body_nonce }),
    ) as unknown;
    const parsed = translationProviderOutputSchema.parse({
      schema_version: 1,
      target_locale: row.target_locale,
      title,
      ...(body as object),
    });
    if (this.digest('result', JSON.stringify(parsed)) !== row.result_hash)
      throw new Error('translation_result_tampered');
    const cacheKey = taskKey(row);
    return {
      taskId: row.id,
      key: cacheKey,
      sourceLocale: row.source_locale,
      targetLocale: row.target_locale,
      providerId: row.provider_id,
      providerVersion: row.provider_version,
      title: parsed.title,
      body: { paragraphs: parsed.paragraphs },
      createdAt: row.result_created_at,
    };
  }

  async findLatest(input: {
    ownerId?: string;
    letterId: string;
    targetLocale: string;
    providerId?: string;
  }): Promise<TranslationTask | null> {
    const result = await this.pool.query<TaskRow>(
      `SELECT * FROM translation.tasks
        WHERE ($1::uuid IS NULL OR owner_id=$1) AND letter_id=$2 AND target_locale=$3
          AND ($4::text IS NULL OR provider_id=$4)
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [input.ownerId, input.letterId, input.targetLocale, input.providerId ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTask(row);
  }

  async saveConsent(input: TranslationConsent): Promise<TranslationConsent> {
    const parsed = input;
    const inserted = await this.pool.query<ConsentRow>(
      `INSERT INTO translation.consents(id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT (owner_id,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds)
       WHERE revoked_at IS NULL DO NOTHING
       RETURNING id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at`,
      [
        parsed.id,
        parsed.owner_id,
        parsed.source_kind,
        parsed.letter_id,
        parsed.source_revision_id,
        parsed.source_hash,
        parsed.provider_id,
        parsed.provider_version,
        parsed.processing_region,
        parsed.retention_policy,
        parsed.retention_seconds,
        parsed.capability,
        parsed.no_training,
        parsed.expires_at,
        parsed.revoked_at,
      ],
    );
    if (inserted.rows[0] !== undefined) return toConsent(inserted.rows[0]);
    const existing = await this.pool.query<ConsentRow>(
      `SELECT id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at
         FROM translation.consents
        WHERE owner_id=$1 AND letter_id=$2 AND source_revision_id=$3 AND source_hash=$4
          AND provider_id=$5 AND provider_version=$6 AND processing_region=$7
          AND retention_policy=$8 AND retention_seconds=$9 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [
        parsed.owner_id,
        parsed.letter_id,
        parsed.source_revision_id,
        parsed.source_hash,
        parsed.provider_id,
        parsed.provider_version,
        parsed.processing_region,
        parsed.retention_policy,
        parsed.retention_seconds,
      ],
    );
    if (existing.rows[0] === undefined) throw new Error('translation_consent_race_lost');
    return toConsent(existing.rows[0]);
  }

  async currentConsent(input: {
    ownerId: string;
    letterId: string;
    sourceRevisionId: string;
    sourceHash: string;
    providerId: string;
    providerVersion: string;
    processingRegion: string;
    retentionPolicy: 'zero' | 'ephemeral' | 'bounded';
    retentionSeconds: number;
    now: Date;
  }): Promise<TranslationConsent | null> {
    const result = await this.pool.query<ConsentRow>(
      `SELECT id,owner_id,source_kind,letter_id,source_revision_id,source_hash,provider_id,provider_version,processing_region,retention_policy,retention_seconds,capability,no_training,expires_at,revoked_at,created_at FROM translation.consents
       WHERE owner_id=$1 AND letter_id=$2 AND source_revision_id=$3 AND source_hash=$4 AND provider_id=$5 AND provider_version=$6 AND processing_region=$7 AND retention_policy=$8 AND retention_seconds=$9 AND revoked_at IS NULL AND expires_at>$10
       ORDER BY created_at DESC LIMIT 1`,
      [
        input.ownerId,
        input.letterId,
        input.sourceRevisionId,
        input.sourceHash,
        input.providerId,
        input.providerVersion,
        input.processingRegion,
        input.retentionPolicy,
        input.retentionSeconds,
        input.now,
      ],
    );
    return result.rows[0] === undefined ? null : toConsent(result.rows[0]);
  }

  async revokeConsent(input: { ownerId: string; consentId: string; now: Date }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE translation.consents SET revoked_at=$1 WHERE id=$2 AND owner_id=$3 AND revoked_at IS NULL`,
      [input.now, input.consentId, input.ownerId],
    );
    return result.rowCount === 1;
  }

  private async loadTask(client: PoolClient, taskId: string): Promise<TranslationTask | null> {
    const result = await client.query<TaskRow>('SELECT * FROM translation.tasks WHERE id=$1', [
      taskId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toTask(row);
  }

  private digest(context: string, value: string): string {
    return hmacDigest(this.hmacKey, `translation:${context}`, value);
  }
}

function taskKey(
  row: Pick<
    TaskRow,
    | 'source_kind'
    | 'letter_id'
    | 'source_revision_id'
    | 'source_revision'
    | 'source_hash'
    | 'source_locale'
    | 'target_locale'
    | 'provider_id'
    | 'provider_version'
  >,
): TranslationCacheKey {
  return translationCacheKeySchema.parse({
    source_kind: row.source_kind,
    letter_id: row.letter_id,
    source_revision_id: row.source_revision_id,
    source_revision: row.source_revision,
    source_hash: row.source_hash,
    source_locale: row.source_locale,
    target_locale: row.target_locale,
    provider_id: row.provider_id,
    provider_version: row.provider_version,
  });
}

function toTask(row: TaskRow, rawLeaseToken?: string): TranslationTask {
  return {
    id: row.id,
    ownerId: row.owner_id,
    key: taskKey(row),
    requestDigest: row.request_digest,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseToken: rawLeaseToken ?? null,
    nextRetryAt: row.next_retry_at,
    leaseUntil: row.lease_until,
    lastErrorCode: row.last_error_code,
    ...(row.consent_provider_version === null ||
    row.consent_processing_region === null ||
    row.consent_retention_policy === null ||
    row.consent_retention_seconds === null
      ? {}
      : {
          consentBinding: {
            id: row.consent_id ?? '',
            providerVersion: row.consent_provider_version,
            processingRegion: row.consent_processing_region,
            retentionPolicy: row.consent_retention_policy,
            retentionSeconds: row.consent_retention_seconds,
          },
        }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConsent(row: ConsentRow): TranslationConsent {
  return {
    ...row,
    expires_at: row.expires_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function freezeTask(task: TranslationTask): FrozenTask {
  return {
    ...task,
    leaseToken: null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    nextRetryAt: task.nextRetryAt?.toISOString() ?? null,
    leaseUntil: null,
  };
}

function fromFrozenTask(task: FrozenTask): TranslationTask {
  return {
    ...task,
    leaseToken: null,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
    nextRetryAt: task.nextRetryAt === null ? null : new Date(task.nextRetryAt),
    leaseUntil: task.leaseUntil === null ? null : new Date(task.leaseUntil),
  };
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

async function ensureWakeup(client: PoolClient, task: TranslationTask, now: Date): Promise<void> {
  if (task.state !== 'queued' && task.state !== 'retry_wait') return;
  const nextRetryAt = task.state === 'queued' ? now : task.nextRetryAt;
  if (nextRetryAt === null) throw new Error('translation_wakeup_time_missing');
  await client.query(
    `INSERT INTO translation.retry_wakeups(task_id,attempt,next_retry_at,enqueued_at,created_at)
     VALUES ($1,$2,$3,NULL,$4)
     ON CONFLICT (task_id) DO NOTHING`,
    [task.id, task.attempts, nextRetryAt, now],
  );
}
