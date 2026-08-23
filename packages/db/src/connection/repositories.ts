import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  connectionResponseSchema,
  idSchema,
  type ConnectionListQuery,
  type ConnectionMode,
  type ConnectionRepositoryPort,
  type ConnectionRow,
  type ConnectionState,
  type ProfileRelationshipGraphPort,
} from '@wai/contracts';

const pairOf = (left: string, right: string): [string, string] =>
  left < right ? [left, right] : [right, left];

const keyedDigest = (pepper: Buffer, context: string, value: string): string =>
  createHmac('sha256', pepper).update(context).update('\0').update(value).digest('hex');

interface ConnectionDbRow {
  id: string;
  requester_account_id: string;
  recipient_account_id: string;
  mode: ConnectionMode;
  state: ConnectionState;
  version: number;
  created_at: Date;
  updated_at: Date;
  accepted_at: Date | null;
  disconnected_at: Date | null;
  cooldown_until: Date | null;
}

export class PgConnectionRepository
  implements ConnectionRepositoryPort, ProfileRelationshipGraphPort
{
  constructor(
    private readonly pool: Pool,
    private readonly pepper: Buffer,
  ) {}

  async currentAccepted(
    senderAccountId: string,
    recipientAccountId: string,
  ): Promise<{
    connectionId: string;
    acceptedEpoch: number;
    mode: ConnectionMode;
  } | null> {
    const [accountA, accountB] = pairOf(senderAccountId, recipientAccountId);
    const result = await this.pool.query<{ id: string; version: number; mode: ConnectionMode }>(
      `SELECT id,version,mode FROM connection.connections
       WHERE account_a=$1 AND account_b=$2 AND state='accepted'
       ORDER BY accepted_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`,
      [accountA, accountB],
    );
    const row = result.rows[0];
    return row ? { connectionId: row.id, acceptedEpoch: row.version, mode: row.mode } : null;
  }

  async isCurrentAccepted(input: {
    connectionId: string;
    acceptedEpoch: number;
    senderAccountId: string;
    recipientAccountId: string;
  }): Promise<{ mode: ConnectionMode } | null> {
    const result = await this.pool.query<{ mode: ConnectionMode }>(
      `SELECT mode FROM connection.connections
       WHERE id=$1 AND state='accepted' AND version=$2
         AND ((requester_account_id=$3 AND recipient_account_id=$4)
           OR (requester_account_id=$4 AND recipient_account_id=$3))`,
      [input.connectionId, input.acceptedEpoch, input.senderAccountId, input.recipientAccountId],
    );
    return result.rows[0] ?? null;
  }

  private keyDigest(value: string): string {
    return keyedDigest(this.pepper, 'connection.idempotency.key.v1', value);
  }

  private payloadDigest(value: string): string {
    return keyedDigest(this.pepper, 'connection.idempotency.payload.v1', value);
  }

  async replayCreateRequest(
    input: Parameters<ConnectionRepositoryPort['replayCreateRequest']>[0],
  ): Promise<ConnectionRow | null> {
    const prior = await this.pool.query<{ payload_digest: string; result_json: unknown }>(
      'SELECT payload_digest,result_json FROM connection.idempotency_keys WHERE actor_account_id=$1 AND operation=$2 AND idempotency_digest=$3',
      [input.actorAccountId, 'create', this.keyDigest(input.idempotencyKey)],
    );
    if (!prior.rows[0]) return null;
    const payloadDigest = this.payloadDigest(
      JSON.stringify({ recipient: input.recipientAccountId, mode: input.mode }),
    );
    if (prior.rows[0].payload_digest !== payloadDigest) throw new Error('IDEMPOTENCY_CONFLICT');
    return fromWire(prior.rows[0].result_json);
  }

  async createRequest(
    input: Parameters<ConnectionRepositoryPort['createRequest']>[0],
  ): Promise<ConnectionRow> {
    if (input.actorAccountId === input.recipientAccountId)
      throw new Error('SELF_CONNECTION_FORBIDDEN');
    const [accountA, accountB] = pairOf(input.actorAccountId, input.recipientAccountId);
    const idempotencyDigest = this.keyDigest(input.idempotencyKey);
    const payloadDigest = this.payloadDigest(
      JSON.stringify({ recipient: input.recipientAccountId, mode: input.mode }),
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${accountA}:${accountB}`,
      ]);
      const prior = await client.query<{ payload_digest: string; result_json: unknown }>(
        'SELECT payload_digest,result_json FROM connection.idempotency_keys WHERE actor_account_id=$1 AND operation=$2 AND idempotency_digest=$3',
        [input.actorAccountId, 'create', idempotencyDigest],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].payload_digest !== payloadDigest) throw new Error('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        return fromWire(prior.rows[0].result_json);
      }
      const activeBlock = await client.query(
        `SELECT 1 FROM safety.blocks
          WHERE state='active'
            AND ((blocker_account_id=$1 AND blocked_account_id=$2)
              OR (blocker_account_id=$2 AND blocked_account_id=$1))
          LIMIT 1`,
        [accountA, accountB],
      );
      if (activeBlock.rowCount !== 0) throw new Error('ACTIVE_BLOCK');
      const current = await client.query<ConnectionDbRow>(
        `SELECT id,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at,disconnected_at,cooldown_until
           FROM connection.connections WHERE account_a=$1 AND account_b=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [accountA, accountB],
      );
      if (current.rows[0]) {
        const existing = toRow(current.rows[0]);
        if (['pending', 'accepted'].includes(existing.state)) {
          if (
            existing.state === 'pending' &&
            existing.requesterAccountId === input.actorAccountId &&
            existing.mode === input.mode
          ) {
            const wire = toWire(existing);
            await this.saveIdempotency(
              client,
              input.actorAccountId,
              'create',
              idempotencyDigest,
              payloadDigest,
              existing.id,
              wire,
            );
            await client.query('COMMIT');
            return existing;
          }
          throw new Error('CONNECTION_TERMINAL');
        }
        if (
          current.rows[0].cooldown_until !== null &&
          current.rows[0].cooldown_until > new Date()
        ) {
          throw new Error('PAIR_COOLDOWN');
        }
      }
      const id = randomUUID();
      const now = new Date();
      const inserted = await client.query<ConnectionDbRow>(
        `INSERT INTO connection.connections
          (id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',0,$7,$7)
         RETURNING id,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at,disconnected_at,cooldown_until`,
        [id, accountA, accountB, input.actorAccountId, input.recipientAccountId, input.mode, now],
      );
      await this.appendTransition(
        client,
        id,
        input.actorAccountId,
        null,
        'pending',
        'request_created',
        now,
      );
      const row = toRow(inserted.rows[0]!);
      await this.saveIdempotency(
        client,
        input.actorAccountId,
        'create',
        idempotencyDigest,
        payloadDigest,
        id,
        toWire(row),
      );
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async replayTransition(
    input: Parameters<ConnectionRepositoryPort['replayTransition']>[0],
  ): Promise<ConnectionRow | null> {
    const prior = await this.pool.query<{ payload_digest: string; result_json: unknown }>(
      'SELECT payload_digest,result_json FROM connection.idempotency_keys WHERE actor_account_id=$1 AND operation=$2 AND idempotency_digest=$3',
      [input.actorAccountId, input.action, this.keyDigest(input.idempotencyKey)],
    );
    if (!prior.rows[0]) return null;
    const payloadDigest = this.payloadDigest(
      JSON.stringify({ connection: input.connectionId, action: input.action }),
    );
    if (prior.rows[0].payload_digest !== payloadDigest) throw new Error('IDEMPOTENCY_CONFLICT');
    return fromWire(prior.rows[0].result_json);
  }

  async getForActor(connectionId: string, actorAccountId: string): Promise<ConnectionRow | null> {
    const result = await this.pool.query<ConnectionDbRow>(
      `SELECT c.id,c.requester_account_id,c.recipient_account_id,c.mode,c.state,c.version,c.created_at,c.updated_at,c.accepted_at,c.disconnected_at,c.cooldown_until
         FROM connection.connections c
        WHERE c.id=$1 AND (c.account_a=$2 OR c.account_b=$2)
          AND c.state <> 'invalidated'
          AND (c.accepted_at IS NULL OR NOT EXISTS (
            SELECT 1 FROM safety.blocks b
             WHERE ((b.blocker_account_id=c.account_a AND b.blocked_account_id=c.account_b)
                 OR (b.blocker_account_id=c.account_b AND b.blocked_account_id=c.account_a))
               AND b.created_at >= c.accepted_at
          ))`,
      [connectionId, actorAccountId],
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  async listForActor(
    actorAccountId: string,
    query: ConnectionListQuery = { limit: 50 },
  ): Promise<{ rows: ConnectionRow[]; nextCursor: string | null }> {
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const limit = query.limit;
    const result = await this.pool.query<ConnectionDbRow>(
      `SELECT c.id,c.requester_account_id,c.recipient_account_id,c.mode,c.state,c.version,c.created_at,c.updated_at,c.accepted_at,c.disconnected_at,c.cooldown_until
         FROM connection.connections c
        WHERE (c.account_a=$1 OR c.account_b=$1)
          AND c.state IN ('pending','accepted')
          AND (c.accepted_at IS NULL OR NOT EXISTS (
            SELECT 1 FROM safety.blocks b
           WHERE ((b.blocker_account_id=c.account_a AND b.blocked_account_id=c.account_b)
                 OR (b.blocker_account_id=c.account_b AND b.blocked_account_id=c.account_a))
               AND b.created_at >= c.accepted_at
          ))
          AND ($2::timestamptz IS NULL OR c.updated_at < $2::timestamptz
            OR (c.updated_at = $2::timestamptz AND c.id < $3::uuid))
        ORDER BY c.updated_at DESC,c.id DESC
        LIMIT $4`,
      [actorAccountId, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit).map(toRow);
    const nextCursor =
      result.rows.length > limit && rows.length > 0
        ? encodeCursor(rows[rows.length - 1]!.updatedAt, rows[rows.length - 1]!.id)
        : null;
    return { rows, nextCursor };
  }

  async transition(
    input: Parameters<ConnectionRepositoryPort['transition']>[0],
  ): Promise<ConnectionRow> {
    const idempotencyDigest = this.keyDigest(input.idempotencyKey);
    const payloadDigest = this.payloadDigest(
      JSON.stringify({ connection: input.connectionId, action: input.action }),
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const pair = await client.query<{ account_a: string; account_b: string }>(
        `SELECT account_a,account_b FROM connection.connections WHERE id=$1 AND (account_a=$2 OR account_b=$2)`,
        [input.connectionId, input.actorAccountId],
      );
      if (!pair.rows[0]) throw new Error('CONNECTION_NOT_FOUND');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:${pair.rows[0].account_a}:${pair.rows[0].account_b}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `connection:idempotency:${input.actorAccountId}:${input.action}:${idempotencyDigest}`,
      ]);
      const prior = await client.query<{ payload_digest: string; result_json: unknown }>(
        'SELECT payload_digest,result_json FROM connection.idempotency_keys WHERE actor_account_id=$1 AND operation=$2 AND idempotency_digest=$3',
        [input.actorAccountId, input.action, idempotencyDigest],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].payload_digest !== payloadDigest) throw new Error('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        return fromWire(prior.rows[0].result_json);
      }
      const result = await client.query<ConnectionDbRow>(
        `SELECT id,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at,disconnected_at,cooldown_until
           FROM connection.connections
          WHERE id=$1 AND (account_a=$2 OR account_b=$2) FOR UPDATE`,
        [input.connectionId, input.actorAccountId],
      );
      const current = result.rows[0];
      if (!current) throw new Error('CONNECTION_NOT_FOUND');
      const row = toRow(current);
      if (row.state === 'invalidated') throw new Error('CONNECTION_INVALIDATED');
      const isRequester = row.requesterAccountId === input.actorAccountId;
      const isRecipient = row.recipientAccountId === input.actorAccountId;
      const allowed =
        (input.action === 'accept' && isRecipient && row.state === 'pending') ||
        (input.action === 'decline' && isRecipient && row.state === 'pending') ||
        (input.action === 'cancel' && isRequester && row.state === 'pending') ||
        (input.action === 'disconnect' && (isRequester || isRecipient) && row.state === 'accepted');
      if (!allowed)
        throw new Error(
          row.state === 'pending' || row.state === 'accepted'
            ? 'CONNECTION_ACTION_FORBIDDEN'
            : 'CONNECTION_TERMINAL',
        );
      const next: Record<typeof input.action, ConnectionState> = {
        accept: 'accepted',
        decline: 'declined',
        cancel: 'cancelled',
        disconnect: 'disconnected',
      };
      const updated = await client.query<ConnectionDbRow>(
        `UPDATE connection.connections SET state=$2,version=version+1,updated_at=now()
          WHERE id=$1 RETURNING id,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at,disconnected_at`,
        [input.connectionId, next[input.action]],
      );
      const changed = toRow(updated.rows[0]!);
      await this.appendTransition(
        client,
        changed.id,
        input.actorAccountId,
        row.state,
        changed.state,
        input.action,
        changed.updatedAt,
      );
      await this.saveIdempotency(
        client,
        input.actorAccountId,
        input.action,
        idempotencyDigest,
        payloadDigest,
        changed.id,
        toWire(changed),
      );
      await client.query('COMMIT');
      return changed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async relationship(
    viewerAccountId: string,
    subjectAccountId: string,
  ): Promise<{ relationship: 'none' | 'connection' }> {
    if (viewerAccountId === subjectAccountId) return { relationship: 'none' };
    const [accountA, accountB] = pairOf(viewerAccountId, subjectAccountId);
    const result = await this.pool.query(
      `SELECT 1 FROM connection.connections c
        WHERE c.account_a=$1 AND c.account_b=$2 AND c.state='accepted'
          AND NOT EXISTS (
            SELECT 1 FROM safety.blocks b
             WHERE ((b.blocker_account_id=$1 AND b.blocked_account_id=$2)
                 OR (b.blocker_account_id=$2 AND b.blocked_account_id=$1))
               AND b.created_at >= c.accepted_at
          ) LIMIT 1`,
      [accountA, accountB],
    );
    return result.rowCount === 1 ? { relationship: 'connection' } : { relationship: 'none' };
  }

  private async appendTransition(
    client: PoolClient,
    connectionId: string,
    actor: string | null,
    from: ConnectionState | null,
    to: ConnectionState,
    reason: string,
    now: Date,
  ) {
    await client.query(
      'INSERT INTO connection.transitions(connection_id,actor_account_id,from_state,to_state,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [connectionId, actor, from, to, reason, now],
    );
  }

  private async saveIdempotency(
    client: PoolClient,
    actor: string,
    operation: string,
    idem: string,
    payload: string,
    connectionId: string,
    result: unknown,
  ) {
    await client.query(
      'INSERT INTO connection.idempotency_keys(actor_account_id,operation,idempotency_digest,payload_digest,connection_id,result_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [actor, operation, idem, payload, connectionId, result, new Date()],
    );
  }
}

function toRow(row: ConnectionDbRow): ConnectionRow {
  return {
    id: row.id,
    requesterAccountId: row.requester_account_id,
    recipientAccountId: row.recipient_account_id,
    mode: row.mode,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    ...(row.disconnected_at === null ? {} : { disconnectedAt: row.disconnected_at }),
  };
}

function toWire(row: ConnectionRow) {
  return connectionResponseSchema.parse({
    id: row.id,
    requester_account_id: row.requesterAccountId,
    recipient_account_id: row.recipientAccountId,
    mode: row.mode,
    state: row.state,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(row.acceptedAt === undefined ? {} : { accepted_at: row.acceptedAt.toISOString() }),
    ...(row.disconnectedAt === undefined
      ? {}
      : { disconnected_at: row.disconnectedAt.toISOString() }),
  });
}

function fromWire(value: unknown): ConnectionRow {
  const row = connectionResponseSchema.parse(value);
  return {
    id: row.id,
    requesterAccountId: row.requester_account_id,
    recipientAccountId: row.recipient_account_id,
    mode: row.mode,
    state: row.state,
    version: row.version,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.accepted_at === undefined ? {} : { acceptedAt: new Date(row.accepted_at) }),
    ...(row.disconnected_at === undefined ? {} : { disconnectedAt: new Date(row.disconnected_at) }),
  };
}

interface ConnectionCursor {
  updatedAt: Date;
  id: string;
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(value: string): ConnectionCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (typeof decoded.updatedAt !== 'string' || typeof decoded.id !== 'string')
      throw new Error('invalid');
    const updatedAt = new Date(decoded.updatedAt);
    if (Number.isNaN(updatedAt.valueOf()) || !idSchema.safeParse(decoded.id).success)
      throw new Error('invalid');
    return { updatedAt, id: decoded.id };
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
