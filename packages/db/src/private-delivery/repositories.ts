import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { aesGcmDecrypt, aesGcmEncrypt, hmacDigest, safeEqual } from '../crypto.js';
import type {
  ConnectionMode,
  PrivateDeliveryCreateResult,
  PrivateDeliveryPurpose,
  PrivateDeliveryRepositoryPort,
  PrivateDeliverySurface,
  LetterContent,
} from '@wai/contracts';
import { letterContentSchema } from '@wai/contracts';

export interface PrivateDeliveryKeyring {
  keyId: string;
  key: Buffer;
  keys?: ReadonlyMap<string, Buffer>;
  hmacKey: Buffer;
}

export class PrivateDeliveryIdempotencyConflictError extends Error {
  constructor() {
    super('private delivery idempotency conflict');
    this.name = 'PrivateDeliveryIdempotencyConflictError';
  }
}
export class PrivateDeliveryNotFoundError extends Error {
  constructor() {
    super('private delivery not found');
    this.name = 'PrivateDeliveryNotFoundError';
  }
}
export class PrivateDeliveryStateError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'PrivateDeliveryStateError';
  }
}

type DeliveryRow = {
  id: string;
  sender_id: string;
  recipient_id: string;
  connection_id: string;
  connection_epoch: number;
  letter_id: string | null;
  revision_id: string | null;
  revision: number;
  source_hash: string;
  purpose: PrivateDeliveryPurpose;
  mode: ConnectionMode;
  state: string;
  snapshot_title_ciphertext: string;
  snapshot_title_nonce: string;
  snapshot_body_ciphertext: string;
  snapshot_body_nonce: string;
  snapshot_metadata_ciphertext: string;
  snapshot_metadata_nonce: string;
  snapshot_key_id: string;
  snapshot_policy_json: Record<string, unknown>;
  lease_owner: string | null;
  lease_token_digest: string | null;
  lease_until: Date | null;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  created_at: Date;
  delivered_at: Date | null;
  read_at: Date | null;
  recipient_hidden_at: Date | null;
  sender_withdrawn_at: Date | null;
};

const pairOf = (left: string, right: string): [string, string] =>
  left < right ? [left, right] : [right, left];

export class PgPrivateDeliveryRepository implements PrivateDeliveryRepositoryPort {
  private readonly keys: ReadonlyMap<string, Buffer>;
  constructor(
    readonly pool: Pool,
    private readonly keyring: PrivateDeliveryKeyring,
  ) {
    if (keyring.key.length !== 32 || keyring.hmacKey.length < 32)
      throw new Error('private_delivery_key_invalid');
    this.keys = keyring.keys ?? new Map([[keyring.keyId, keyring.key]]);
  }

  private keyDigest(value: string): string {
    return hmacDigest(this.keyring.hmacKey, 'pvl.idempotency.key.v1', value);
  }
  private payloadDigest(value: unknown): string {
    return hmacDigest(this.keyring.hmacKey, 'pvl.idempotency.payload.v1', JSON.stringify(value));
  }
  private leaseDigest(value: string): string {
    return hmacDigest(this.keyring.hmacKey, 'pvl.lease.v1', value);
  }
  private cursorDigest(value: string): string {
    return hmacDigest(this.keyring.hmacKey, 'pvl.cursor.v1', value);
  }

  async replayCreate(input: {
    senderAccountId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<PrivateDeliveryCreateResult | null> {
    const result = await this.pool.query<{
      payload_digest: string;
      result_json: PrivateDeliveryCreateResult;
    }>(
      `SELECT payload_digest,result_json FROM private_delivery.idempotency_keys
       WHERE sender_id=$1 AND key_digest=$2`,
      [input.senderAccountId, this.keyDigest(input.idempotencyKey)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!safeEqual(row.payload_digest, this.payloadDigest(input.payload)))
      throw new PrivateDeliveryIdempotencyConflictError();
    return row.result_json;
  }

  async createQueued(input: {
    senderAccountId: string;
    recipientAccountId: string;
    connectionId: string;
    connectionEpoch: number;
    mode: ConnectionMode;
    purpose: PrivateDeliveryPurpose;
    snapshot: {
      letterId: string;
      revisionId: string;
      revision: number;
      sourceHash: string;
      content: LetterContent;
    };
    idempotencyKey: string;
  }): Promise<PrivateDeliveryCreateResult> {
    const client = await this.pool.connect();
    const payload = {
      recipient_id: input.recipientAccountId,
      letter_id: input.snapshot.letterId,
      revision: input.snapshot.revision,
      purpose: input.purpose,
    };
    const keyDigest = this.keyDigest(input.idempotencyKey);
    const payloadDigest = this.payloadDigest(payload);
    try {
      await client.query('BEGIN');
      const [accountA, accountB] = pairOf(input.senderAccountId, input.recipientAccountId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `pvl:${input.senderAccountId}:${keyDigest}`,
      ]);
      const prior = await client.query<{
        payload_digest: string;
        result_json: PrivateDeliveryCreateResult;
      }>(
        `SELECT payload_digest,result_json FROM private_delivery.idempotency_keys WHERE sender_id=$1 AND key_digest=$2 FOR UPDATE`,
        [input.senderAccountId, keyDigest],
      );
      if (prior.rows[0]) {
        if (!safeEqual(prior.rows[0].payload_digest, payloadDigest))
          throw new PrivateDeliveryIdempotencyConflictError();
        await client.query('COMMIT');
        return prior.rows[0].result_json;
      }
      const binding = await client.query<{ owner_id: string; kind: string; source_hash: string }>(
        `SELECT l.owner_id,l.kind,r.source_hash FROM letters.letters l JOIN letters.letter_revisions r ON r.letter_id=l.id
         WHERE l.id=$1 AND r.id=$2 AND r.revision=$3 FOR SHARE`,
        [input.snapshot.letterId, input.snapshot.revisionId, input.snapshot.revision],
      );
      const bound = binding.rows[0];
      if (
        !bound ||
        bound.owner_id !== input.senderAccountId ||
        bound.kind !== 'private_letter' ||
        bound.source_hash !== input.snapshot.sourceHash
      )
        throw new PrivateDeliveryStateError('LETTER_REVISION_BINDING_INVALID');
      const connection = await client.query<{ mode: ConnectionMode }>(
        `SELECT mode FROM connection.connections c WHERE c.id=$1 AND c.state='accepted' AND c.version=$2
         AND ((c.requester_account_id=$3 AND c.recipient_account_id=$4) OR (c.requester_account_id=$4 AND c.recipient_account_id=$3)) FOR SHARE`,
        [
          input.connectionId,
          input.connectionEpoch,
          input.senderAccountId,
          input.recipientAccountId,
        ],
      );
      if (!connection.rows[0] || connection.rows[0].mode !== input.mode)
        throw new PrivateDeliveryStateError('CONNECTION_NOT_CURRENT');
      const block = await client.query(
        `SELECT 1 FROM safety.blocks WHERE state='active' AND ((blocker_account_id=$1 AND blocked_account_id=$2) OR (blocker_account_id=$2 AND blocked_account_id=$1)) LIMIT 1`,
        [input.senderAccountId, input.recipientAccountId],
      );
      if (block.rowCount) throw new PrivateDeliveryStateError('ACTIVE_BLOCK');
      const existing = await client.query<{
        id: string;
        state: 'queued' | 'leased' | 'delivered' | 'cancelled' | 'failed';
        revision: number;
        created_at: Date;
      }>(
        `SELECT id,state,revision,created_at FROM private_delivery.deliveries
         WHERE sender_id=$1 AND recipient_id=$2 AND connection_id=$3 AND connection_epoch=$4 AND letter_id=$5 AND revision=$6 AND purpose=$7 FOR UPDATE`,
        [
          input.senderAccountId,
          input.recipientAccountId,
          input.connectionId,
          input.connectionEpoch,
          input.snapshot.letterId,
          input.snapshot.revision,
          input.purpose,
        ],
      );
      if (existing.rows[0]) {
        const priorResult: PrivateDeliveryCreateResult = {
          deliveryId: existing.rows[0].id,
          senderAccountId: input.senderAccountId,
          recipientAccountId: input.recipientAccountId,
          state: existing.rows[0].state,
          revision: existing.rows[0].revision,
          createdAt: existing.rows[0].created_at.toISOString(),
        };
        await client.query(
          `INSERT INTO private_delivery.idempotency_keys(sender_id,key_digest,payload_digest,delivery_id,result_json,created_at) VALUES ($1,$2,$3,$4,$5,now())`,
          [input.senderAccountId, keyDigest, payloadDigest, existing.rows[0].id, priorResult],
        );
        if (existing.rows[0].state === 'queued') {
          await client.query(
            `INSERT INTO private_delivery.wake_intents(delivery_id,kind,state,attempts,max_attempts,available_at,created_at,updated_at)
             VALUES ($1,'delivery','pending',0,20,now(),now(),now()) ON CONFLICT (delivery_id,kind) DO NOTHING`,
            [existing.rows[0].id],
          );
        }
        await client.query('COMMIT');
        return priorResult;
      }
      const now = new Date();
      const deliveryId = randomUUID();
      const title = aesGcmEncrypt(this.keyring.key, input.snapshot.content.title);
      const body = aesGcmEncrypt(this.keyring.key, JSON.stringify(input.snapshot.content.body));
      const metadata = aesGcmEncrypt(
        this.keyring.key,
        JSON.stringify({
          locale: input.snapshot.content.locale,
          country_code: input.snapshot.content.country_code,
          topics: input.snapshot.content.topics,
          content_reminder: input.snapshot.content.content_reminder,
          pen_name: input.snapshot.content.pen_name,
        }),
      );
      const policy = {
        engine: 'interaction-gate',
        checked_at: now.toISOString(),
        require_connection: true,
      };
      await client.query(
        `INSERT INTO private_delivery.deliveries
         (id,sender_id,recipient_id,connection_id,connection_epoch,letter_id,revision_id,revision,source_hash,purpose,mode,state,
          snapshot_title_ciphertext,snapshot_title_nonce,snapshot_body_ciphertext,snapshot_body_nonce,snapshot_metadata_ciphertext,snapshot_metadata_nonce,snapshot_key_id,snapshot_policy_json,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          deliveryId,
          input.senderAccountId,
          input.recipientAccountId,
          input.connectionId,
          input.connectionEpoch,
          input.snapshot.letterId,
          input.snapshot.revisionId,
          input.snapshot.revision,
          input.snapshot.sourceHash,
          input.purpose,
          input.mode,
          title.ciphertext,
          title.nonce,
          body.ciphertext,
          body.nonce,
          metadata.ciphertext,
          metadata.nonce,
          this.keyring.keyId,
          policy,
          now,
        ],
      );
      await client.query(
        `INSERT INTO private_delivery.transitions(delivery_id,from_state,to_state,actor_id,reason,created_at) VALUES ($1,NULL,'queued',$2,'created',$3)`,
        [deliveryId, input.senderAccountId, now],
      );
      const result: PrivateDeliveryCreateResult = {
        deliveryId,
        senderAccountId: input.senderAccountId,
        recipientAccountId: input.recipientAccountId,
        state: 'queued',
        revision: input.snapshot.revision,
        createdAt: now.toISOString(),
      };
      await client.query(
        `INSERT INTO private_delivery.idempotency_keys(sender_id,key_digest,payload_digest,delivery_id,result_json,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.senderAccountId, keyDigest, payloadDigest, deliveryId, result, now],
      );
      await client.query(
        `INSERT INTO private_delivery.wake_intents(delivery_id,kind,state,attempts,max_attempts,available_at,created_at,updated_at)
         VALUES ($1,'delivery','pending',0,20,$2,$2,$2) ON CONFLICT (delivery_id,kind) DO NOTHING`,
        [deliveryId, now],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(input: { workerId: string; leaseMs: number; deliveryId?: string }): Promise<{
    deliveryId: string;
    leaseToken: string;
    senderAccountId: string;
    recipientAccountId: string;
    connectionId: string;
    connectionEpoch: number;
    mode: ConnectionMode;
  } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<DeliveryRow>(
        `SELECT * FROM private_delivery.deliveries WHERE ($1::uuid IS NULL OR id=$1::uuid) AND ((state='queued' AND available_at <= now() AND attempts < max_attempts) OR (state='leased' AND lease_until < now() AND attempts < max_attempts)) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [input.deliveryId ?? null],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const token = randomUUID();
      const until = new Date(Date.now() + input.leaseMs);
      const from = row.state;
      await client.query(
        `UPDATE private_delivery.deliveries SET state='leased',lease_owner=$1,lease_token_digest=$2,lease_until=$3,attempts=attempts+1 WHERE id=$4`,
        [input.workerId, this.leaseDigest(token), until, row.id],
      );
      await client.query(
        `INSERT INTO private_delivery.transitions(delivery_id,from_state,to_state,actor_id,reason,created_at) VALUES ($1,$2,'leased',NULL,'claim',$3)`,
        [row.id, from, new Date()],
      );
      await client.query('COMMIT');
      return {
        deliveryId: row.id,
        leaseToken: token,
        senderAccountId: row.sender_id,
        recipientAccountId: row.recipient_id,
        connectionId: row.connection_id,
        connectionEpoch: row.connection_epoch,
        mode: row.mode,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(input: {
    deliveryId: string;
    leaseToken: string;
  }): Promise<'delivered' | 'cancelled' | 'stale'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const identity = await client.query<{ sender_id: string; recipient_id: string }>(
        `SELECT sender_id,recipient_id FROM private_delivery.deliveries WHERE id=$1`,
        [input.deliveryId],
      );
      const identityRow = identity.rows[0];
      if (!identityRow) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      const [accountA, accountB] = pairOf(identityRow.sender_id, identityRow.recipient_id);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      const row = await client.query<DeliveryRow>(
        `SELECT * FROM private_delivery.deliveries WHERE id=$1 FOR UPDATE`,
        [input.deliveryId],
      );
      const current = row.rows[0];
      if (
        !current ||
        current.state !== 'leased' ||
        current.lease_until === null ||
        current.lease_until <= new Date() ||
        current.lease_token_digest !== this.leaseDigest(input.leaseToken)
      ) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      const accepted = await client.query(
        `SELECT 1 FROM connection.connections WHERE id=$1 AND state='accepted' AND version=$2`,
        [current.connection_id, current.connection_epoch],
      );
      const blocked = await client.query(
        `SELECT 1 FROM safety.blocks WHERE state='active' AND ((blocker_account_id=$1 AND blocked_account_id=$2) OR (blocker_account_id=$2 AND blocked_account_id=$1)) LIMIT 1`,
        [current.sender_id, current.recipient_id],
      );
      if (!accepted.rowCount || blocked.rowCount) {
        await client.query(
          `UPDATE private_delivery.deliveries SET state='cancelled',cancelled_at=now(),lease_owner=NULL,lease_token_digest=NULL,lease_until=NULL,last_error_code=$2 WHERE id=$1`,
          [current.id, blocked.rowCount ? 'ACTIVE_BLOCK' : 'CONNECTION_NOT_CURRENT'],
        );
        await client.query(
          `INSERT INTO private_delivery.transitions(delivery_id,from_state,to_state,actor_id,reason,created_at) VALUES ($1,'leased','cancelled',NULL,$2,now())`,
          [current.id, blocked.rowCount ? 'active_block' : 'stale_connection'],
        );
        await client.query(
          `UPDATE private_delivery.wake_intents SET state='suppressed',updated_at=now() WHERE delivery_id=$1 AND kind='delivery'`,
          [current.id],
        );
        await client.query('COMMIT');
        return 'cancelled';
      }
      await client.query(
        `UPDATE private_delivery.deliveries SET state='delivered',delivered_at=now(),lease_owner=NULL,lease_token_digest=NULL,lease_until=NULL WHERE id=$1`,
        [current.id],
      );
      await client.query(
        `INSERT INTO private_delivery.transitions(delivery_id,from_state,to_state,actor_id,reason,created_at) VALUES ($1,'leased','delivered',NULL,'worker_complete',now())`,
        [current.id],
      );
      await client.query(
        `INSERT INTO private_delivery.notification_outbox(id,delivery_id,recipient_id,event_type,payload_json,created_at) VALUES ($1,$2,$3,'private_delivery.delivered',$4,now()) ON CONFLICT(delivery_id,event_type) DO NOTHING`,
        [
          randomUUID(),
          current.id,
          current.recipient_id,
          { delivery_id: current.id, event: 'private_delivery.delivered' },
        ],
      );
      await client.query(
        `UPDATE private_delivery.wake_intents SET state='suppressed',updated_at=now() WHERE delivery_id=$1 AND kind='delivery'`,
        [current.id],
      );
      await client.query(
        `INSERT INTO private_delivery.wake_intents(delivery_id,kind,state,attempts,max_attempts,available_at,created_at,updated_at)
         VALUES ($1,'notification','pending',0,20,now(),now(),now()) ON CONFLICT (delivery_id,kind) DO NOTHING`,
        [current.id],
      );
      await client.query('COMMIT');
      return 'delivered';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(input: {
    deliveryId: string;
    leaseToken: string;
    reason: string;
  }): Promise<'cancelled' | 'stale'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const identity = await client.query<{ sender_id: string; recipient_id: string }>(
        `SELECT sender_id,recipient_id FROM private_delivery.deliveries WHERE id=$1`,
        [input.deliveryId],
      );
      if (!identity.rows[0]) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      const [accountA, accountB] = pairOf(
        identity.rows[0].sender_id,
        identity.rows[0].recipient_id,
      );
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      const result = await client.query(
        `UPDATE private_delivery.deliveries SET state='cancelled',cancelled_at=now(),lease_owner=NULL,lease_token_digest=NULL,lease_until=NULL,last_error_code=$3
       WHERE id=$1 AND state='leased' AND lease_token_digest=$2 AND lease_until > now()`,
        [input.deliveryId, this.leaseDigest(input.leaseToken), input.reason.slice(0, 64)],
      );
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      await client.query(
        `INSERT INTO private_delivery.transitions(delivery_id,from_state,to_state,actor_id,reason,created_at) VALUES ($1,'leased','cancelled',NULL,$2,now())`,
        [input.deliveryId, input.reason.slice(0, 128)],
      );
      await client.query(
        `UPDATE private_delivery.wake_intents SET state='suppressed',updated_at=now() WHERE delivery_id=$1 AND kind='delivery'`,
        [input.deliveryId],
      );
      await client.query('COMMIT');
      return 'cancelled';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async retry(input: {
    deliveryId: string;
    leaseToken: string;
    reason: string;
    retryAfterMs: number;
  }): Promise<'retrying' | 'failed' | 'stale'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const identity = await client.query<{ sender_id: string; recipient_id: string }>(
        `SELECT sender_id,recipient_id FROM private_delivery.deliveries WHERE id=$1`,
        [input.deliveryId],
      );
      if (!identity.rows[0]) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      const [accountA, accountB] = pairOf(
        identity.rows[0].sender_id,
        identity.rows[0].recipient_id,
      );
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      const current = await client.query<{ attempts: number; max_attempts: number }>(
        `SELECT attempts,max_attempts FROM private_delivery.deliveries WHERE id=$1 AND state='leased' AND lease_token_digest=$2 AND lease_until > now() FOR UPDATE`,
        [input.deliveryId, this.leaseDigest(input.leaseToken)],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      if (row.attempts >= row.max_attempts) {
        await client.query(
          `UPDATE private_delivery.deliveries SET state='failed',failed_at=now(),lease_owner=NULL,lease_token_digest=NULL,lease_until=NULL,last_error_code=$2 WHERE id=$1`,
          [input.deliveryId, input.reason.slice(0, 64)],
        );
        await client.query(
          `INSERT INTO private_delivery.transitions(delivery_id,from_state,to_state,actor_id,reason,created_at) VALUES ($1,'leased','failed',NULL,$2,now())`,
          [input.deliveryId, input.reason.slice(0, 128)],
        );
        await client.query(
          `UPDATE private_delivery.wake_intents SET state='failed',last_error_code=$2,updated_at=now() WHERE delivery_id=$1 AND kind='delivery'`,
          [input.deliveryId, input.reason.slice(0, 64)],
        );
        await client.query('COMMIT');
        return 'failed';
      }
      await client.query(
        `UPDATE private_delivery.deliveries SET state='queued',available_at=now()+($2::integer * interval '1 millisecond'),lease_owner=NULL,lease_token_digest=NULL,lease_until=NULL,last_error_code=$3 WHERE id=$1`,
        [
          input.deliveryId,
          Math.max(1, Math.min(input.retryAfterMs, 300_000)),
          input.reason.slice(0, 64),
        ],
      );
      await client.query(
        `INSERT INTO private_delivery.transitions(delivery_id,from_state,to_state,actor_id,reason,created_at) VALUES ($1,'leased','queued',NULL,$2,now())`,
        [input.deliveryId, input.reason.slice(0, 128)],
      );
      await client.query(
        `UPDATE private_delivery.wake_intents SET state='pending',available_at=now()+($2::integer * interval '1 millisecond'),last_error_code=$3,updated_at=now() WHERE delivery_id=$1 AND kind='delivery'`,
        [
          input.deliveryId,
          Math.max(1, Math.min(input.retryAfterMs, 300_000)),
          input.reason.slice(0, 64),
        ],
      );
      await client.query('COMMIT');
      return 'retrying';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private decode(row: DeliveryRow): Record<string, unknown> {
    const key = this.keys.get(row.snapshot_key_id);
    if (!key) throw new PrivateDeliveryStateError('SNAPSHOT_KEY_UNAVAILABLE');
    try {
      const content = letterContentSchema.parse({
        title: aesGcmDecrypt(key, {
          ciphertext: row.snapshot_title_ciphertext,
          nonce: row.snapshot_title_nonce,
        }),
        body: JSON.parse(
          aesGcmDecrypt(key, {
            ciphertext: row.snapshot_body_ciphertext,
            nonce: row.snapshot_body_nonce,
          }),
        ),
        ...JSON.parse(
          aesGcmDecrypt(key, {
            ciphertext: row.snapshot_metadata_ciphertext,
            nonce: row.snapshot_metadata_nonce,
          }),
        ),
      });
      return {
        id: row.id,
        sender_id: row.sender_id,
        recipient_id: row.recipient_id,
        state: row.state,
        revision: row.revision,
        connection_id: row.connection_id,
        connection_epoch: row.connection_epoch,
        mode: row.mode,
        created_at: row.created_at.toISOString(),
        delivered_at: row.delivered_at?.toISOString() ?? null,
        read_at: row.read_at?.toISOString() ?? null,
        recipient_hidden_at: row.recipient_hidden_at?.toISOString() ?? null,
        sender_withdrawn_at: row.sender_withdrawn_at?.toISOString() ?? null,
        content,
      };
    } catch {
      throw new PrivateDeliveryStateError('SNAPSHOT_TAMPERED');
    }
  }

  async getForRecipient(recipientAccountId: string, deliveryId: string): Promise<unknown | null> {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT d.* FROM private_delivery.deliveries d JOIN connection.connections c ON c.id=d.connection_id AND c.version=d.connection_epoch AND c.state='accepted' WHERE d.id=$1 AND d.recipient_id=$2 AND d.state='delivered' AND d.recipient_hidden_at IS NULL AND NOT EXISTS (SELECT 1 FROM safety.blocks b WHERE b.state='active' AND ((b.blocker_account_id=d.sender_id AND b.blocked_account_id=d.recipient_id) OR (b.blocker_account_id=d.recipient_id AND b.blocked_account_id=d.sender_id)))`,
      [deliveryId, recipientAccountId],
    );
    return result.rows[0] ? this.decode(result.rows[0]) : null;
  }
  async getForSender(senderAccountId: string, deliveryId: string): Promise<unknown | null> {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT * FROM private_delivery.deliveries WHERE id=$1 AND sender_id=$2 AND sender_withdrawn_at IS NULL`,
      [deliveryId, senderAccountId],
    );
    return result.rows[0]
      ? {
          id: result.rows[0].id,
          recipient_id: result.rows[0].recipient_id,
          connection_id: result.rows[0].connection_id,
          connection_epoch: result.rows[0].connection_epoch,
          mode: result.rows[0].mode,
          state: result.rows[0].state,
          revision: result.rows[0].revision,
          created_at: result.rows[0].created_at.toISOString(),
          delivered_at: result.rows[0].delivered_at?.toISOString() ?? null,
          read_at: result.rows[0].read_at?.toISOString() ?? null,
        }
      : null;
  }
  async list(input: {
    actorAccountId: string;
    surface: PrivateDeliverySurface;
    cursor?: string;
    limit: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    let after: { createdAt: string; id: string } | undefined;
    if (input.cursor) {
      try {
        const encoded = input.cursor.slice(0, -64);
        const sig = input.cursor.slice(-64);
        const raw = encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : '';
        if (!raw || !/^[0-9a-f]{64}$/.test(sig) || !safeEqual(sig, this.cursorDigest(raw)))
          throw new Error();
        const parsed = JSON.parse(raw) as {
          v: 1;
          actor: string;
          surface: PrivateDeliverySurface;
          createdAt: string;
          id: string;
          exp: number;
        };
        if (
          parsed.v !== 1 ||
          parsed.exp < Date.now() ||
          parsed.exp > Date.now() + 900_001 ||
          parsed.actor !== input.actorAccountId ||
          parsed.surface !== input.surface ||
          !Number.isInteger(parsed.exp) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            parsed.id,
          ) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.createdAt) ||
          new Date(parsed.createdAt).toISOString() !== parsed.createdAt
        )
          throw new Error();
        after = { createdAt: parsed.createdAt, id: parsed.id };
      } catch {
        throw new PrivateDeliveryStateError('INVALID_CURSOR');
      }
    }
    const owner = input.surface === 'inbox' ? 'recipient_id' : 'sender_id';
    const values: unknown[] = [input.actorAccountId];
    let where = `d.${owner}=$1 AND d.state='delivered' AND c.state='accepted' AND c.version=d.connection_epoch AND ${input.surface === 'inbox' ? 'd.recipient_hidden_at IS NULL' : 'd.sender_withdrawn_at IS NULL'} AND NOT EXISTS (SELECT 1 FROM safety.blocks b WHERE b.state='active' AND ((b.blocker_account_id=d.sender_id AND b.blocked_account_id=d.recipient_id) OR (b.blocker_account_id=d.recipient_id AND b.blocked_account_id=d.sender_id)))`;
    if (after) {
      values.push(after.createdAt, after.id);
      where += ` AND (d.created_at,d.id) < ($2::timestamptz,$3::uuid)`;
    }
    values.push(input.limit + 1);
    const rows = await this.pool.query<DeliveryRow>(
      `SELECT d.* FROM private_delivery.deliveries d JOIN connection.connections c ON c.id=d.connection_id WHERE ${where} ORDER BY d.created_at DESC,d.id DESC LIMIT $${values.length}`,
      values,
    );
    const page = rows.rows.slice(0, input.limit).map((row) =>
      input.surface === 'inbox'
        ? this.decode(row)
        : {
            id: row.id,
            recipient_id: row.recipient_id,
            connection_id: row.connection_id,
            connection_epoch: row.connection_epoch,
            mode: row.mode,
            state: row.state,
            revision: row.revision,
            created_at: row.created_at.toISOString(),
            delivered_at: row.delivered_at?.toISOString() ?? null,
            read_at: row.read_at?.toISOString() ?? null,
          },
    );
    const last = rows.rows[input.limit - 1];
    const raw =
      last && rows.rows.length > input.limit
        ? JSON.stringify({
            v: 1,
            actor: input.actorAccountId,
            surface: input.surface,
            createdAt: last.created_at.toISOString(),
            id: last.id,
            exp: Date.now() + 900_000,
          })
        : null;
    return {
      items: page,
      nextCursor: raw ? `${Buffer.from(raw).toString('base64url')}${this.cursorDigest(raw)}` : null,
    };
  }
  async markRead(recipientAccountId: string, deliveryId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE private_delivery.deliveries SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_id=$2 AND state='delivered' AND recipient_hidden_at IS NULL`,
      [deliveryId, recipientAccountId],
    );
    if (!result.rowCount) throw new PrivateDeliveryNotFoundError();
  }
  async hide(recipientAccountId: string, deliveryId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE private_delivery.deliveries SET recipient_hidden_at=COALESCE(recipient_hidden_at,now()) WHERE id=$1 AND recipient_id=$2 AND state='delivered'`,
      [deliveryId, recipientAccountId],
    );
    if (!result.rowCount) throw new PrivateDeliveryNotFoundError();
  }
  async captureEvidence(input: {
    deliveryId: string;
    actorAccountId: string;
    category: string;
  }): Promise<void> {
    const row = await this.pool.query<DeliveryRow>(
      `SELECT * FROM private_delivery.deliveries WHERE id=$1 AND state='delivered' AND (sender_id=$2 OR recipient_id=$2)`,
      [input.deliveryId, input.actorAccountId],
    );
    if (!row.rows[0]) throw new PrivateDeliveryNotFoundError();
    const snapshot = JSON.stringify({
      delivery: this.decode(row.rows[0]),
      captured_at: new Date().toISOString(),
    });
    const encrypted = aesGcmEncrypt(this.keyring.key, snapshot);
    await this.pool.query(
      `INSERT INTO private_delivery.evidence_snapshots(id,delivery_id,captured_by,category,ciphertext,nonce,key_id,source_hash,captured_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(delivery_id,category) DO NOTHING`,
      [
        randomUUID(),
        row.rows[0].id,
        input.actorAccountId,
        input.category,
        encrypted.ciphertext,
        encrypted.nonce,
        this.keyring.keyId,
        row.rows[0].source_hash,
      ],
    );
  }
  async withdraw(input: { senderAccountId: string; deliveryId: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE private_delivery.deliveries SET sender_withdrawn_at=COALESCE(sender_withdrawn_at,now()) WHERE id=$1 AND sender_id=$2 AND state='delivered'`,
      [input.deliveryId, input.senderAccountId],
    );
    if (!result.rowCount) throw new PrivateDeliveryNotFoundError();
  }
  async getDeliveryContext(deliveryId: string) {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT * FROM private_delivery.deliveries WHERE id=$1`,
      [deliveryId],
    );
    const row = result.rows[0];
    return row
      ? {
          deliveryId: row.id,
          senderAccountId: row.sender_id,
          recipientAccountId: row.recipient_id,
          connectionId: row.connection_id,
          connectionEpoch: row.connection_epoch,
          mode: row.mode,
          state: row.state as PrivateDeliveryCreateResult['state'],
        }
      : null;
  }
  async shouldWake(deliveryId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE private_delivery.wake_intents w SET state='pending',attempts=0,available_at=now(),last_error_code=NULL,updated_at=now()
           WHERE w.delivery_id=$1 AND w.state='failed' AND EXISTS (
             SELECT 1 FROM private_delivery.deliveries d
              WHERE d.id=w.delivery_id AND ((w.kind='delivery' AND d.state='queued') OR (w.kind='notification' AND d.state='delivered' AND EXISTS (SELECT 1 FROM private_delivery.notification_outbox o WHERE o.delivery_id=d.id AND o.state='pending'))))`,
        [deliveryId],
      );
      const result = await client.query(
        `SELECT 1 FROM private_delivery.wake_intents w JOIN private_delivery.deliveries d ON d.id=w.delivery_id
          WHERE w.delivery_id=$1 AND w.state='pending' AND w.available_at <= now()
            AND ((w.kind='delivery' AND d.state='queued') OR (w.kind='notification' AND d.state='delivered' AND EXISTS (SELECT 1 FROM private_delivery.notification_outbox o WHERE o.delivery_id=d.id AND o.state='pending'))) LIMIT 1`,
        [deliveryId],
      );
      await client.query('COMMIT');
      return Boolean(result.rowCount);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileDueWakeups(limit: number): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{
        delivery_id: string;
        attempts: number;
        max_attempts: number;
      }>(
        `SELECT w.delivery_id,w.attempts,w.max_attempts
           FROM private_delivery.wake_intents w
           JOIN private_delivery.deliveries d ON d.id=w.delivery_id
          WHERE w.state='pending' AND w.available_at <= now() AND w.attempts < w.max_attempts
            AND ((w.kind='delivery' AND d.state='queued') OR
                 (w.kind='notification' AND d.state='delivered' AND EXISTS (SELECT 1 FROM private_delivery.notification_outbox o WHERE o.delivery_id=d.id AND o.state='pending')))
          ORDER BY w.available_at,w.delivery_id
          LIMIT $1 FOR UPDATE OF w SKIP LOCKED`,
        [Math.max(1, Math.min(limit, 100))],
      );
      const ids = new Set<string>();
      for (const row of due.rows) {
        await client.query(
          `UPDATE private_delivery.wake_intents SET attempts=attempts+1,available_at=now()+interval '5 seconds',updated_at=now() WHERE delivery_id=$1 AND attempts=$2`,
          [row.delivery_id, row.attempts],
        );
        ids.add(row.delivery_id);
      }
      await client.query(
        `UPDATE private_delivery.wake_intents SET state='failed',last_error_code='WAKE_ATTEMPTS_EXHAUSTED',updated_at=now()
          WHERE state='pending' AND attempts >= max_attempts`,
      );
      await client.query('COMMIT');
      return [...ids];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async dispatchOutbox(input: {
    deliveryId: string;
    recipientAccountId: string;
    allowed: boolean;
    retryable?: boolean;
  }): Promise<'dispatched' | 'cancelled' | 'retrying' | 'stale'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const delivery = await client.query<{ sender_id: string; recipient_id: string }>(
        `SELECT sender_id,recipient_id FROM private_delivery.deliveries WHERE id=$1 FOR SHARE`,
        [input.deliveryId],
      );
      if (!delivery.rows[0]) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      const [accountA, accountB] = pairOf(
        delivery.rows[0].sender_id,
        delivery.rows[0].recipient_id,
      );
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      if (input.retryable) {
        const pending = await client.query(
          `SELECT o.id FROM private_delivery.notification_outbox o JOIN private_delivery.deliveries d ON d.id=o.delivery_id JOIN connection.connections c ON c.id=d.connection_id AND c.version=d.connection_epoch WHERE o.delivery_id=$1 AND o.recipient_id=$2 AND o.state='pending' AND d.state='delivered' AND c.state='accepted' AND NOT EXISTS (SELECT 1 FROM safety.blocks b WHERE b.state='active' AND ((b.blocker_account_id=d.sender_id AND b.blocked_account_id=d.recipient_id) OR (b.blocker_account_id=d.recipient_id AND b.blocked_account_id=d.sender_id))) FOR UPDATE`,
          [input.deliveryId, input.recipientAccountId],
        );
        if (pending.rowCount) {
          await client.query('COMMIT');
          return 'retrying';
        }
      }
      const result = await client.query<{ state: 'dispatched' | 'cancelled' }>(
        `UPDATE private_delivery.notification_outbox o SET state=CASE WHEN $3::boolean AND c.state='accepted' AND c.version=d.connection_epoch AND NOT EXISTS (SELECT 1 FROM safety.blocks b WHERE b.state='active' AND ((b.blocker_account_id=d.sender_id AND b.blocked_account_id=d.recipient_id) OR (b.blocker_account_id=d.recipient_id AND b.blocked_account_id=d.sender_id))) THEN 'dispatched' ELSE 'cancelled' END,dispatched_at=CASE WHEN $3::boolean AND c.state='accepted' AND c.version=d.connection_epoch AND NOT EXISTS (SELECT 1 FROM safety.blocks b WHERE b.state='active' AND ((b.blocker_account_id=d.sender_id AND b.blocked_account_id=d.recipient_id) OR (b.blocker_account_id=d.recipient_id AND b.blocked_account_id=d.sender_id))) THEN now() ELSE NULL END FROM private_delivery.deliveries d JOIN connection.connections c ON c.id=d.connection_id WHERE o.delivery_id=$1 AND o.recipient_id=$2 AND o.state='pending' AND d.state='delivered' RETURNING o.state`,
        [input.deliveryId, input.recipientAccountId, input.allowed],
      );
      if (result.rows[0]) {
        await client.query(
          `UPDATE private_delivery.wake_intents SET state='suppressed',updated_at=now() WHERE delivery_id=$1 AND kind='notification'`,
          [input.deliveryId],
        );
      }
      await client.query('COMMIT');
      if (!result.rows[0]) return 'stale';
      return result.rows[0].state;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
