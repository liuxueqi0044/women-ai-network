import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { aesGcmDecrypt, aesGcmEncrypt, safeEqual } from '../crypto.js';
import type {
  MessagingRepositoryPort,
  MessagingConversationCreateInput,
  MessagingSendInput,
  MessagingHistoryInput,
  MessagingDraftInput,
  MessagingConversation,
  MessagingMessage,
  MessagingDraft,
  MessagingInboxState,
  ConnectionMode,
} from '@wai/contracts';

type Keys = { keyId: string; key: Buffer; keys: ReadonlyMap<string, Buffer>; hmacKey: Buffer };
interface ConnectionDb {
  requester_account_id: string;
  recipient_account_id: string;
  mode: ConnectionMode;
}
interface DeliveryDb {
  id: string;
  sender_id: string;
  recipient_id: string;
  connection_id: string;
  connection_epoch: number;
  revision: number;
  source_hash: string;
  state: string;
  delivered_at: Date | null;
  mode: ConnectionMode;
  recipient_hidden_at: Date | null;
  sender_withdrawn_at: Date | null;
}
interface ConversationDb {
  id: string;
  connection_id: string;
  connection_epoch: number;
  account_a: string;
  account_b: string;
  mode: ConnectionMode;
  opening_delivery_id: string | null;
  opening_revision: number | null;
  opening_source_hash: string | null;
  created_at: Date;
  updated_at: Date;
}
interface MessageDb {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_message_id: string;
  idempotency_key_digest: string;
  request_digest: string;
  server_sequence: string;
  body_ciphertext: string;
  body_nonce: string;
  body_key_id: string;
  body_hash: string;
  state: 'active' | 'withdrawn';
  created_at: Date;
  withdrawn_at: Date | null;
}
interface DraftDb {
  id: string;
  conversation_id: string;
  owner_id: string;
  provider: string;
  ciphertext: string;
  nonce: string;
  key_id: string;
  expires_at: Date;
  created_at: Date;
}
const hash = (key: Buffer, v: string) => createHmac('sha256', key).update(v).digest('hex');
const digest = (key: Buffer, ctx: string, v: string) =>
  createHmac('sha256', key).update(`${ctx}\0${v}`).digest('hex');
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export class PgMessagingRepository implements MessagingRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly crypto: Keys,
  ) {}

  async getConnectionParticipants(actorAccountId: string, connectionId: string, epoch: number) {
    const r = await this.pool.query<ConnectionDb>(
      `SELECT requester_account_id,recipient_account_id,mode FROM connection.connections WHERE id=$1 AND version=$2 AND state='accepted' AND (requester_account_id=$3 OR recipient_account_id=$3)`,
      [connectionId, epoch, actorAccountId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      subjectAccountId:
        row.requester_account_id === actorAccountId
          ? row.recipient_account_id
          : row.requester_account_id,
      mode: row.mode,
    };
  }

  async createConversation(
    input: MessagingConversationCreateInput,
  ): Promise<MessagingConversation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Read the immutable pair first.  Every subsequent row lock is behind
      // the same pair advisory lock used by connection transitions and SAF.
      const c = await client.query<ConnectionDb & { id: string }>(
        `SELECT id,mode,requester_account_id,recipient_account_id FROM connection.connections WHERE id=$1 AND state='accepted' AND version=$2`,
        [input.connectionId, input.connectionEpoch],
      );
      const row = c.rows[0];
      if (
        !row ||
        !(
          (row.requester_account_id === input.actorAccountId &&
            row.recipient_account_id === input.subjectAccountId) ||
          (row.requester_account_id === input.subjectAccountId &&
            row.recipient_account_id === input.actorAccountId)
        )
      )
        throw new Error('CONNECTION_NOT_CURRENT');
      await this.lockPair(client, row.requester_account_id, row.recipient_account_id);
      const current = await client.query<ConnectionDb>(
        `SELECT mode,requester_account_id,recipient_account_id FROM connection.connections WHERE id=$1 AND state='accepted' AND version=$2 FOR UPDATE`,
        [input.connectionId, input.connectionEpoch],
      );
      if (!current.rows[0]) throw new Error('CONNECTION_NOT_CURRENT');
      const blocked = await client.query(
        `SELECT 1 FROM safety.blocks WHERE state='active' AND ((blocker_account_id=$1 AND blocked_account_id=$2) OR (blocker_account_id=$2 AND blocked_account_id=$1)) LIMIT 1`,
        [input.actorAccountId, input.subjectAccountId],
      );
      if (blocked.rows[0]) throw new Error('CONNECTION_NOT_CURRENT');
      const [a, b] = pair(input.actorAccountId, input.subjectAccountId);
      let opening: { deliveryId: string; revision: number; sourceHash: string } | null = null;
      if (input.openingReference) {
        const d = await client.query<DeliveryDb>(
          `SELECT id,recipient_id,sender_id,connection_id,connection_epoch,revision,source_hash,state,delivered_at,mode,recipient_hidden_at,sender_withdrawn_at FROM private_delivery.deliveries WHERE id=$1 AND revision=$2 AND source_hash=$3 AND state='delivered' AND delivered_at IS NOT NULL AND recipient_hidden_at IS NULL AND sender_withdrawn_at IS NULL`,
          [
            input.openingReference.deliveryId,
            input.openingReference.revision,
            input.openingReference.sourceHash,
          ],
        );
        const delivery = d.rows[0];
        if (
          !delivery ||
          delivery.mode !== row.mode ||
          delivery.connection_id !== input.connectionId ||
          delivery.connection_epoch !== input.connectionEpoch ||
          !(
            (delivery.sender_id === a && delivery.recipient_id === b) ||
            (delivery.sender_id === b && delivery.recipient_id === a)
          )
        )
          throw new Error('OPENING_REFERENCE_INVALID');
        opening = input.openingReference;
      }
      const result = await client.query<ConversationDb>(
        `INSERT INTO messaging.conversations (id,connection_id,connection_epoch,account_a,account_b,mode,opening_delivery_id,opening_revision,opening_source_hash,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now()) ON CONFLICT (connection_id,connection_epoch) WHERE state='active' DO UPDATE SET updated_at=messaging.conversations.updated_at RETURNING *`,
        [
          randomUUID(),
          input.connectionId,
          input.connectionEpoch,
          a,
          b,
          row.mode,
          opening?.deliveryId ?? null,
          opening?.revision ?? null,
          opening?.sourceHash ?? null,
        ],
      );
      await client.query('COMMIT');
      const conversation = result.rows[0];
      if (!conversation) throw new Error('CONVERSATION_CREATE_FAILED');
      return this.toConversation(conversation, input.actorAccountId);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getConversation(actorAccountId: string, conversationId: string) {
    const r = await this.pool.query<ConversationDb>(
      'SELECT * FROM messaging.conversations WHERE id=$1 AND (account_a=$2 OR account_b=$2)',
      [conversationId, actorAccountId],
    );
    return r.rows[0] ? this.toConversation(r.rows[0], actorAccountId) : null;
  }
  async getMessageContext(actorAccountId: string, messageId: string) {
    const r = await this.pool.query<MessageDb>('SELECT * FROM messaging.messages WHERE id=$1', [
      messageId,
    ]);
    const msg = r.rows[0];
    if (!msg) return null;
    const c = await this.pool.query<ConversationDb>(
      'SELECT * FROM messaging.conversations WHERE id=$1 AND (account_a=$2 OR account_b=$2)',
      [msg.conversation_id, actorAccountId],
    );
    const conversation = c.rows[0];
    if (!conversation) return null;
    return {
      conversation: this.toConversation(conversation, actorAccountId),
      senderAccountId: msg.sender_id,
    };
  }
  async getMessageEvidence(actorAccountId: string, messageId: string) {
    const r = await this.pool.query<{
      sender_id: string;
      server_sequence: string;
      state: 'active' | 'withdrawn';
      conversation_id: string;
    }>(
      'SELECT sender_id,server_sequence,state,conversation_id FROM messaging.messages WHERE id=$1',
      [messageId],
    );
    const message = r.rows[0];
    if (!message) return null;
    const c = await this.pool.query<{ account_a: string; account_b: string }>(
      'SELECT account_a,account_b FROM messaging.conversations WHERE id=$1 AND (account_a=$2 OR account_b=$2)',
      [message.conversation_id, actorAccountId],
    );
    if (!c.rows[0]) return null;
    return {
      subjectAccountId: message.sender_id,
      sourceVersion: message.server_sequence,
      moderationState: message.state === 'active' ? ('visible' as const) : ('removed' as const),
    };
  }
  /**
   * Safety reporting intentionally bypasses the live connection gate.  The
   * authorization is nevertheless transactional and pair-bound: only a
   * historical participant can report the other participant's message.
   * No encrypted body, translation, or AI context crosses this port.
   */
  async getReportableMessageEvidence(actorAccountId: string, messageId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const pairRow = await client.query<{
        account_a: string;
        account_b: string;
      }>(
        `SELECT c.account_a,c.account_b
           FROM messaging.messages m
           JOIN messaging.conversations c ON c.id=m.conversation_id
          WHERE m.id=$1`,
        [messageId],
      );
      const pairRowValue = pairRow.rows[0];
      if (!pairRowValue) {
        await client.query('COMMIT');
        return null;
      }
      await this.lockPair(client, pairRowValue.account_a, pairRowValue.account_b);
      const row = await client.query<{
        sender_id: string;
        server_sequence: string;
        state: 'active' | 'withdrawn';
        account_a: string;
        account_b: string;
      }>(
        `SELECT m.sender_id,m.server_sequence,m.state,c.account_a,c.account_b
           FROM messaging.messages m
           JOIN messaging.conversations c ON c.id=m.conversation_id
          WHERE m.id=$1
          FOR UPDATE OF m,c`,
        [messageId],
      );
      const message = row.rows[0];
      if (
        !message ||
        actorAccountId === message.sender_id ||
        (actorAccountId !== message.account_a && actorAccountId !== message.account_b)
      ) {
        await client.query('COMMIT');
        return null;
      }
      await client.query('COMMIT');
      return {
        subjectAccountId: message.sender_id,
        sourceVersion: message.server_sequence,
        moderationState: message.state === 'active' ? ('visible' as const) : ('removed' as const),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listConversations(actorAccountId: string, query: { cursor?: string; limit: number }) {
    const cur = query.cursor ? this.decodeCursor(query.cursor, actorAccountId, 'list') : null;
    const listCursor = cur && 'at' in cur ? cur : null;
    const r = await this.pool.query<ConversationDb>(
      `SELECT m.* FROM messaging.conversations m JOIN connection.connections c ON c.id=m.connection_id AND c.version=m.connection_epoch AND c.state='accepted' AND c.mode=m.mode JOIN iam.accounts a ON a.id=c.account_a AND a.state='enabled' JOIN iam.accounts b ON b.id=c.account_b AND b.state='enabled' WHERE m.state='active' AND (m.account_a=$1 OR m.account_b=$1) AND NOT EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND ((bl.blocker_account_id=m.account_a AND bl.blocked_account_id=m.account_b) OR (bl.blocker_account_id=m.account_b AND bl.blocked_account_id=m.account_a))) AND ($2::timestamptz IS NULL OR m.updated_at<$2 OR (m.updated_at=$2 AND m.id<$3)) ORDER BY m.updated_at DESC,m.id DESC LIMIT $4`,
      [actorAccountId, listCursor?.at ?? null, listCursor?.id ?? null, query.limit + 1],
    );
    const rows = r.rows.slice(0, query.limit).map((x) => this.toConversation(x, actorAccountId));
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor:
        r.rows.length > query.limit && last
          ? this.encodeCursor(actorAccountId, 'list', last.updated_at, last.id)
          : null,
    };
  }

  async getInboxState(
    actorAccountId: string,
    conversationId: string,
  ): Promise<MessagingInboxState | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const context = await client.query<{ account_a: string; account_b: string }>(
        'SELECT account_a,account_b FROM messaging.conversations WHERE id=$1 AND (account_a=$2 OR account_b=$2)',
        [conversationId, actorAccountId],
      );
      if (!context.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      await this.lockPair(client, context.rows[0].account_a, context.rows[0].account_b);
      await this.assertCurrentConversation(client, conversationId, actorAccountId);
      const latest = await client.query<MessageDb>(
        `SELECT * FROM messaging.messages
          WHERE conversation_id=$1
          ORDER BY server_sequence DESC
          LIMIT 1`,
        [conversationId],
      );
      const unread = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM messaging.messages m
          WHERE m.conversation_id=$1
            AND m.sender_id<>$2
            AND m.state='active'
            AND NOT EXISTS (
              SELECT 1 FROM messaging.receipts r
               WHERE r.message_id=m.id AND r.viewer_id=$2 AND r.read_at IS NOT NULL
            )`,
        [conversationId, actorAccountId],
      );
      const result = {
        last_message: latest.rows[0] ? this.toMessage(latest.rows[0]) : null,
        unread_count: Number(unread.rows[0]?.count ?? '0'),
      };
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getConversationUnreadCount(
    actorAccountId: string,
    conversationId: string,
  ): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const context = await client.query<{ account_a: string; account_b: string }>(
        'SELECT account_a,account_b FROM messaging.conversations WHERE id=$1 AND (account_a=$2 OR account_b=$2)',
        [conversationId, actorAccountId],
      );
      if (!context.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      await this.lockPair(client, context.rows[0].account_a, context.rows[0].account_b);
      await this.assertCurrentConversation(client, conversationId, actorAccountId);
      const unread = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM messaging.messages m
          WHERE m.conversation_id=$1
            AND m.sender_id<>$2
            AND m.state='active'
            AND NOT EXISTS (
              SELECT 1 FROM messaging.receipts r
               WHERE r.message_id=m.id AND r.viewer_id=$2 AND r.read_at IS NOT NULL
            )`,
        [conversationId, actorAccountId],
      );
      await client.query('COMMIT');
      return Number(unread.rows[0]?.count ?? '0');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markConversationRead(
    actorAccountId: string,
    conversationId: string,
    throughMessageId: string,
  ): Promise<{ unreadCount: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{
        server_sequence: string;
        sender_id: string;
        account_a: string;
        account_b: string;
      }>(
        `SELECT m.server_sequence,m.sender_id,c.account_a,c.account_b
           FROM messaging.messages m
           JOIN messaging.conversations c ON c.id=m.conversation_id
          WHERE m.id=$1 AND m.conversation_id=$2 AND (c.account_a=$3 OR c.account_b=$3)`,
        [throughMessageId, conversationId, actorAccountId],
      );
      const row = target.rows[0];
      if (!row || row.sender_id === actorAccountId) throw new Error('MESSAGE_NOT_FOUND');
      await this.lockPair(client, row.account_a, row.account_b);
      await this.assertCurrentConversation(client, conversationId, actorAccountId);
      await client.query(
        `INSERT INTO messaging.receipts(message_id,viewer_id,delivered_at,read_at)
         SELECT m.id,$2,now(),now()
           FROM messaging.messages m
          WHERE m.conversation_id=$1 AND m.sender_id<>$2 AND m.server_sequence<=$3
         ON CONFLICT(message_id,viewer_id) DO UPDATE
         SET delivered_at=COALESCE(messaging.receipts.delivered_at,EXCLUDED.delivered_at),
             read_at=COALESCE(messaging.receipts.read_at,EXCLUDED.read_at)`,
        [conversationId, actorAccountId, row.server_sequence],
      );
      const unread = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM messaging.messages m
          WHERE m.conversation_id=$1
            AND m.sender_id<>$2
            AND m.state='active'
            AND NOT EXISTS (
              SELECT 1 FROM messaging.receipts r
               WHERE r.message_id=m.id AND r.viewer_id=$2 AND r.read_at IS NOT NULL
            )`,
        [conversationId, actorAccountId],
      );
      await client.query('COMMIT');
      return { unreadCount: Number(unread.rows[0]?.count ?? '0') };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async sendMessage(input: MessagingSendInput): Promise<MessagingMessage> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Do not lock a conversation before the pair lock.  This is the common
      // lock order with connection transitions and SAF block creation.
      const pairRow = await client.query<{ account_a: string; account_b: string }>(
        'SELECT c.account_a,c.account_b FROM messaging.conversations m JOIN connection.connections c ON c.id=m.connection_id WHERE m.id=$1',
        [input.conversationId],
      );
      if (!pairRow.rows[0]) throw new Error('CONNECTION_NOT_CURRENT');
      await this.lockPair(client, pairRow.rows[0].account_a, pairRow.rows[0].account_b);
      const keyDigest = digest(
        this.crypto.hmacKey,
        'messaging.idempotency.key.v1',
        input.idempotencyKey,
      );
      const requestDigest = digest(
        this.crypto.hmacKey,
        'messaging.idempotency.request.v1',
        `${input.clientMessageId}\0${input.body}`,
      );
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `messaging:idempotency:${input.actorAccountId}:${keyDigest}`,
      ]);
      const prior = await client.query<MessageDb>(
        'SELECT * FROM messaging.messages WHERE sender_id=$1 AND (idempotency_key_digest=$2 OR (conversation_id=$3 AND client_message_id=$4))',
        [input.actorAccountId, keyDigest, input.conversationId, input.clientMessageId],
      );
      if (prior.rows[0]) {
        if (
          prior.rows[0].conversation_id !== input.conversationId ||
          prior.rows[0].body_hash !== hash(this.crypto.hmacKey, input.body) ||
          prior.rows[0].idempotency_key_digest !== keyDigest ||
          prior.rows[0].request_digest !== requestDigest
        )
          throw new Error('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        return this.toMessage(prior.rows[0]);
      }
      await this.assertCurrentConversation(
        client,
        input.conversationId,
        input.actorAccountId,
        input.recipientId,
      );
      const seq = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(server_sequence),0)+1 AS next FROM messaging.messages WHERE conversation_id=$1`,
        [input.conversationId],
      );
      const nextSequence = seq.rows[0]?.next;
      if (!nextSequence) throw new Error('SEQUENCE_UNAVAILABLE');
      const encrypted = aesGcmEncrypt(this.crypto.key, input.body);
      const inserted = await client.query<MessageDb>(
        `INSERT INTO messaging.messages (id,conversation_id,sender_id,client_message_id,idempotency_key_digest,request_digest,server_sequence,body_ciphertext,body_nonce,body_key_id,body_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) RETURNING *`,
        [
          randomUUID(),
          input.conversationId,
          input.actorAccountId,
          input.clientMessageId,
          keyDigest,
          requestDigest,
          nextSequence,
          encrypted.ciphertext,
          encrypted.nonce,
          this.crypto.keyId,
          hash(this.crypto.hmacKey, input.body),
        ],
      );
      const msg = inserted.rows[0];
      if (!msg) throw new Error('MESSAGE_CREATE_FAILED');
      await client.query(
        'UPDATE messaging.conversations SET updated_at=GREATEST(updated_at,$2) WHERE id=$1',
        [input.conversationId, msg.created_at],
      );
      if (input.recipientId)
        await client.query(
          `INSERT INTO messaging.notification_outbox (id,conversation_id,message_id,recipient_id,event_type,payload_json,created_at) VALUES ($1,$2,$3,$4,'message.wake',jsonb_build_object('conversation_id',($2::uuid)::text,'message_id',($3::uuid)::text,'event','message.wake'),now())`,
          [randomUUID(), input.conversationId, msg.id, input.recipientId],
        );
      await client.query('COMMIT');
      return this.toMessage(msg);
    } catch (e) {
      await client.query('ROLLBACK');
      if (
        typeof e === 'object' &&
        e !== null &&
        (e as { code?: string; constraint?: string }).code === '23505' &&
        ((e as { constraint?: string }).constraint ?? '').includes('idempotency')
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      throw e;
    } finally {
      client.release();
    }
  }
  async history(input: MessagingHistoryInput & { connectionEpoch: number }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const pairRow = await client.query<{ account_a: string; account_b: string }>(
        'SELECT account_a,account_b FROM messaging.conversations WHERE id=$1',
        [input.conversationId],
      );
      if (!pairRow.rows[0]) throw new Error('CONNECTION_NOT_CURRENT');
      await this.lockPair(client, pairRow.rows[0].account_a, pairRow.rows[0].account_b);
      await this.assertCurrentConversation(client, input.conversationId, input.actorAccountId);
      const boundary = `${input.conversationId}:${input.connectionEpoch}`;
      const cur = input.cursor
        ? this.decodeCursor(input.cursor, input.actorAccountId, boundary)
        : null;
      const historyCursor = cur && 'seq' in cur ? cur : null;
      const r = await client.query<MessageDb>(
        `SELECT * FROM messaging.messages WHERE conversation_id=$1 AND server_sequence<$2 ORDER BY server_sequence DESC LIMIT $3`,
        [input.conversationId, historyCursor?.seq ?? '9223372036854775807', input.limit + 1],
      );
      const rows = r.rows.slice(0, input.limit).map((x) => this.toMessage(x));
      const last = rows[rows.length - 1];
      const result = {
        items: rows,
        nextCursor:
          r.rows.length > input.limit && last
            ? this.encodeCursor(input.actorAccountId, boundary, last.server_sequence, last.id)
            : null,
      };
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async withdraw(actorAccountId: string, messageId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const context = await client.query<{
        conversation_id: string;
        account_a: string;
        account_b: string;
      }>(
        `SELECT m.conversation_id,c.account_a,c.account_b
           FROM messaging.messages m JOIN messaging.conversations c ON c.id=m.conversation_id
          WHERE m.id=$1 AND m.sender_id=$2`,
        [messageId, actorAccountId],
      );
      if (!context.rows[0]) throw new Error('MESSAGE_NOT_FOUND');
      await this.lockPair(client, context.rows[0].account_a, context.rows[0].account_b);
      await this.assertCurrentConversation(client, context.rows[0].conversation_id, actorAccountId);
      const r = await client.query<MessageDb>(
        `UPDATE messaging.messages SET state='withdrawn',withdrawn_at=now() WHERE id=$1 AND sender_id=$2 AND state='active' RETURNING *`,
        [messageId, actorAccountId],
      );
      if (!r.rows[0]) throw new Error('MESSAGE_NOT_FOUND');
      await client.query('COMMIT');
      return this.toMessage(r.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async receipt(actorAccountId: string, messageId: string, kind: 'delivered' | 'read') {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{
        conversation_id: string;
        sender_id: string;
        account_a: string;
        account_b: string;
      }>(
        `SELECT m.conversation_id,m.sender_id,c.account_a,c.account_b
           FROM messaging.messages m JOIN messaging.conversations c ON c.id=m.conversation_id
          WHERE m.id=$1`,
        [messageId],
      );
      if (!r.rows[0] || r.rows[0].sender_id === actorAccountId)
        throw new Error('MESSAGE_NOT_FOUND');
      await this.lockPair(client, r.rows[0].account_a, r.rows[0].account_b);
      await this.assertCurrentConversation(client, r.rows[0].conversation_id, actorAccountId);
      if (kind === 'delivered') {
        await client.query(
          `INSERT INTO messaging.receipts(message_id,viewer_id,delivered_at) VALUES ($1,$2,now()) ON CONFLICT(message_id,viewer_id) DO UPDATE SET delivered_at=COALESCE(messaging.receipts.delivered_at,now())`,
          [messageId, actorAccountId],
        );
      } else {
        await client.query(
          `INSERT INTO messaging.receipts(message_id,viewer_id,delivered_at,read_at) VALUES ($1,$2,now(),now()) ON CONFLICT(message_id,viewer_id) DO UPDATE SET delivered_at=COALESCE(messaging.receipts.delivered_at,now()), read_at=COALESCE(messaging.receipts.read_at,now())`,
          [messageId, actorAccountId],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async createAiDraft(input: MessagingDraftInput): Promise<MessagingDraft> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const pairRow = await client.query<{ account_a: string; account_b: string }>(
        'SELECT account_a,account_b FROM messaging.conversations WHERE id=$1',
        [input.conversationId],
      );
      if (!pairRow.rows[0]) throw new Error('CONNECTION_NOT_CURRENT');
      await this.lockPair(client, pairRow.rows[0].account_a, pairRow.rows[0].account_b);
      await this.assertCurrentConversation(client, input.conversationId, input.actorAccountId);
      const text = input.body;
      const encrypted = aesGcmEncrypt(this.crypto.key, text);
      const r = await client.query<DraftDb>(
        `INSERT INTO messaging.ai_drafts(id,conversation_id,owner_id,ciphertext,nonce,key_id,provider,consent_json,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '15 minutes',now()) RETURNING id,provider,expires_at,created_at,ciphertext,nonce,key_id`,
        [
          randomUUID(),
          input.conversationId,
          input.actorAccountId,
          encrypted.ciphertext,
          encrypted.nonce,
          this.crypto.keyId,
          input.provider,
          input.consent,
        ],
      );
      const row = r.rows[0];
      if (!row) throw new Error('DRAFT_CREATE_FAILED');
      const result = {
        id: row.id,
        provider: row.provider,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        draft: text,
      };
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async getAiDraft(actorAccountId: string, draftId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<
        DraftDb & { connection_id: string; account_a: string; account_b: string }
      >(
        'SELECT d.*, c.connection_id,c.account_a,c.account_b FROM messaging.ai_drafts d JOIN messaging.conversations c ON c.id=d.conversation_id WHERE d.id=$1 AND d.owner_id=$2 AND d.deleted_at IS NULL AND d.expires_at>now()',
        [draftId, actorAccountId],
      );
      if (!r.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const row = r.rows[0];
      await this.lockPair(client, row.account_a, row.account_b);
      await this.assertCurrentConversation(client, row.conversation_id, actorAccountId);
      const key = this.crypto.keys.get(row.key_id);
      if (!key) throw new Error('KEY_UNAVAILABLE');
      const result = {
        id: row.id,
        provider: row.provider,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        draft: aesGcmDecrypt(key, { ciphertext: row.ciphertext, nonce: row.nonce }),
      };
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async getAiDraftConversation(actorAccountId: string, draftId: string) {
    const r = await this.pool.query<ConversationDb>(
      'SELECT c.* FROM messaging.ai_drafts d JOIN messaging.conversations c ON c.id=d.conversation_id WHERE d.id=$1 AND d.owner_id=$2 AND d.deleted_at IS NULL AND d.expires_at>now()',
      [draftId, actorAccountId],
    );
    return r.rows[0] ? this.toConversation(r.rows[0], actorAccountId) : null;
  }
  async deleteAiDraft(actorAccountId: string, draftId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{
        conversation_id: string;
        account_a: string;
        account_b: string;
      }>(
        `SELECT d.conversation_id,c.account_a,c.account_b
           FROM messaging.ai_drafts d JOIN messaging.conversations c ON c.id=d.conversation_id
          WHERE d.id=$1 AND d.owner_id=$2 AND d.deleted_at IS NULL`,
        [draftId, actorAccountId],
      );
      if (r.rows[0]) {
        await this.lockPair(client, r.rows[0].account_a, r.rows[0].account_b);
        await this.assertCurrentConversation(client, r.rows[0].conversation_id, actorAccountId);
        await client.query(
          'UPDATE messaging.ai_drafts SET deleted_at=now() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',
          [draftId, actorAccountId],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async claimOutbox(limit: number, leaseOwner: string) {
    const r = await this.pool.query<{
      id: string;
      conversation_id: string;
      message_id: string;
      recipient_id: string;
    }>(
      `WITH due AS (SELECT id FROM messaging.notification_outbox WHERE state='pending' AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE messaging.notification_outbox o SET lease_owner=$2,lease_until=now()+interval '30 seconds',attempts=o.attempts+1 FROM due WHERE o.id=due.id RETURNING o.id,o.conversation_id,o.message_id,o.recipient_id`,
      [limit, leaseOwner],
    );
    return r.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      recipientId: row.recipient_id,
    }));
  }
  async authorizeOutbox(
    id: string,
    leaseOwner: string,
  ): Promise<
    | {
        status: 'authorized';
        hint: { conversation_id: string; message_id: string; event: 'message.wake' };
      }
    | { status: 'cancelled' }
    | { status: 'retry' }
  > {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = await client.query<{
        conversation_id: string;
        message_id: string;
        recipient_id: string;
        account_a: string;
        account_b: string;
      }>(
        "SELECT o.conversation_id,o.message_id,o.recipient_id,c.account_a,c.account_b FROM messaging.notification_outbox o JOIN messaging.conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.lease_owner=$2 AND o.lease_until>now() AND o.state='pending'",
        [id, leaseOwner],
      );
      if (!candidate.rows[0]) {
        await client.query('ROLLBACK');
        return { status: 'retry' };
      }
      await this.lockPair(client, candidate.rows[0].account_a, candidate.rows[0].account_b);
      const row = await client.query<{
        conversation_id: string;
        message_id: string;
        recipient_id: string;
      }>(
        "SELECT conversation_id,message_id,recipient_id FROM messaging.notification_outbox WHERE id=$1 AND lease_owner=$2 AND lease_until>now() AND state='pending' FOR UPDATE",
        [id, leaseOwner],
      );
      if (!row.rows[0]) {
        await client.query('ROLLBACK');
        return { status: 'retry' };
      }
      try {
        await this.assertCurrentConversation(
          client,
          row.rows[0].conversation_id,
          row.rows[0].recipient_id,
        );
      } catch {
        await client.query(
          "UPDATE messaging.notification_outbox SET state='cancelled',lease_owner=NULL,lease_until=NULL,last_error_code='CONNECTION_NOT_CURRENT' WHERE id=$1",
          [id],
        );
        await client.query('COMMIT');
        return { status: 'cancelled' };
      }
      await client.query('COMMIT');
      return {
        status: 'authorized',
        hint: {
          conversation_id: row.rows[0].conversation_id,
          message_id: row.rows[0].message_id,
          event: 'message.wake',
        },
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async completeOutbox(id: string, leaseOwner: string): Promise<'dispatched' | 'retry'> {
    const r = await this.pool.query(
      "UPDATE messaging.notification_outbox SET state='dispatched',dispatched_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_until>now() AND state='pending'",
      [id, leaseOwner],
    );
    return r.rowCount === 1 ? 'dispatched' : 'retry';
  }
  async failOutbox(id: string, leaseOwner: string, errorCode: string): Promise<'retry' | 'stale'> {
    const r = await this.pool.query(
      "UPDATE messaging.notification_outbox SET lease_owner=NULL,lease_until=NULL,last_error_code=$3 WHERE id=$1 AND lease_owner=$2 AND state='pending'",
      [id, leaseOwner, errorCode.slice(0, 128)],
    );
    return r.rowCount === 1 ? 'retry' : 'stale';
  }
  async releaseStaleOutbox(leaseOwner: string) {
    const r = await this.pool.query(
      "UPDATE messaging.notification_outbox SET lease_owner=NULL,lease_until=NULL,last_error_code='STALE_LEASE' WHERE state='pending' AND lease_owner=$1 AND lease_until<=now()",
      [leaseOwner],
    );
    return r.rowCount ?? 0;
  }
  async reapExpiredAiDrafts(limit: number) {
    const r = await this.pool.query(
      `WITH expired AS (SELECT id FROM messaging.ai_drafts WHERE deleted_at IS NULL AND expires_at<=now() ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE messaging.ai_drafts d SET deleted_at=now() FROM expired WHERE d.id=expired.id AND d.deleted_at IS NULL`,
      [limit],
    );
    return r.rowCount ?? 0;
  }

  private toConversation(row: ConversationDb, actor: string): MessagingConversation {
    return {
      id: row.id,
      connection_id: row.connection_id,
      connection_epoch: row.connection_epoch,
      mode: row.mode,
      participant_account_id: row.account_a === actor ? row.account_b : row.account_a,
      opening_reference: row.opening_delivery_id
        ? {
            delivery_id: row.opening_delivery_id,
            revision: row.opening_revision!,
            source_hash: row.opening_source_hash!,
          }
        : null,
      opening_context: row.opening_delivery_id
        ? {
            status: 'delivered_reference' as const,
            original_locale: null,
            machine_translation_available: false,
          }
        : null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }
  private async lockPair(client: PoolClient, left: string, right: string): Promise<void> {
    const [a, b] = pair(left, right);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `connection:${a}:${b}`,
    ]);
  }
  private toMessage(row: MessageDb): MessagingMessage {
    let body: string | null = null;
    if (row.state === 'active') {
      const key = this.crypto.keys.get(row.body_key_id);
      if (!key) throw new Error('KEY_UNAVAILABLE');
      body = aesGcmDecrypt(key, { ciphertext: row.body_ciphertext, nonce: row.body_nonce });
    }
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      sender_account_id: row.sender_id,
      client_message_id: row.client_message_id,
      server_sequence: String(row.server_sequence),
      body,
      state: row.state,
      created_at: new Date(row.created_at).toISOString(),
      withdrawn_at: row.withdrawn_at ? new Date(row.withdrawn_at).toISOString() : null,
    };
  }
  private encodeCursor(viewer: string, boundary: string, value: string | Date, id: string) {
    const p = JSON.stringify({
      v: viewer,
      b: boundary,
      e: Date.now() + 86400000,
      value: String(value),
      id,
    });
    const sig = digest(this.crypto.hmacKey, 'messaging.cursor.v1', p);
    return Buffer.from(JSON.stringify({ p, sig })).toString('base64url');
  }
  private decodeCursor(
    cursor: string,
    viewer: string,
    boundary: string,
  ): { at: Date; id: string } | { seq: string; id: string } {
    try {
      const d: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (
        !d ||
        typeof d !== 'object' ||
        !('p' in d) ||
        !('sig' in d) ||
        typeof d.p !== 'string' ||
        typeof d.sig !== 'string' ||
        !safeEqual(digest(this.crypto.hmacKey, 'messaging.cursor.v1', d.p), d.sig)
      )
        throw new Error();
      const p: unknown = JSON.parse(d.p);
      if (
        !p ||
        typeof p !== 'object' ||
        !('v' in p) ||
        !('b' in p) ||
        !('e' in p) ||
        !('value' in p) ||
        !('id' in p) ||
        p.v !== viewer ||
        p.b !== boundary ||
        typeof p.e !== 'number' ||
        p.e < Date.now() ||
        typeof p.value !== 'string' ||
        typeof p.id !== 'string'
      )
        throw new Error();
      if (boundary !== 'list' && !/^\d+$/.test(p.value)) throw new Error();
      if (boundary === 'list' && Number.isNaN(new Date(p.value).valueOf())) throw new Error();
      return boundary === 'list' ? { at: new Date(p.value), id: p.id } : { seq: p.value, id: p.id };
    } catch {
      throw new Error('INVALID_CURSOR');
    }
  }
  private async assertCurrentConversation(
    client: PoolClient,
    conversationId: string,
    actorAccountId: string,
    subjectAccountId?: string,
  ): Promise<void> {
    const r = await client.query<{ id: string }>(
      `SELECT m.id FROM messaging.conversations m
       JOIN connection.connections c ON c.id=m.connection_id AND c.version=m.connection_epoch
         AND c.state='accepted' AND c.mode=m.mode
       JOIN iam.accounts a ON a.id=c.account_a AND a.state='enabled'
       JOIN iam.accounts b ON b.id=c.account_b AND b.state='enabled'
       WHERE m.id=$1 AND m.state='active' AND (c.account_a=$2 OR c.account_b=$2)
         AND ($3::uuid IS NULL OR c.account_a=$3 OR c.account_b=$3)
         AND NOT EXISTS (SELECT 1 FROM safety.blocks bl WHERE bl.state='active' AND
           ((bl.blocker_account_id=c.account_a AND bl.blocked_account_id=c.account_b)
           OR (bl.blocker_account_id=c.account_b AND bl.blocked_account_id=c.account_a)))
       FOR UPDATE OF m,c`,
      [conversationId, actorAccountId, subjectAccountId ?? null],
    );
    if (!r.rows[0]) throw new Error('CONNECTION_NOT_CURRENT');
  }
}
