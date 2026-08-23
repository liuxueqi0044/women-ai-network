import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import {
  MigrationRunner,
  PgConnectionRepository,
  PgMessagingRepository,
  PgSafetyRepository,
} from '@wai/db';
import { withInfra } from '@wai/testkit';
import { MessagingWakeupRunner } from '../../../apps/worker/src/messaging/runner.js';
import { MessagingService } from '../../../apps/api/src/messaging/messaging.service.js';
import { SafetyService } from '../../../apps/api/src/safety/safety.service.js';

describe('MSG-01 PostgreSQL lifecycle and authority', () => {
  it('migration_fresh_noop_down_up_and_opaque_schema', async () => {
    await withInfra(async (infra) => {
      const pool = new pg.Pool({ connectionString: infra.databaseUrl });
      try {
        const migrationRunner = new MigrationRunner(
          pool,
          process.env['WAI_MIGRATIONS_DIR'] ?? `${process.cwd()}\\packages\\db\\migrations`,
          { through: '0014_messaging.sql' },
        );
        const first = await migrationRunner.up();
        expect(first.applied).toContain('0014_messaging.sql');
        const second = await migrationRunner.up();
        expect(second.applied).toHaveLength(0);
        expect(second.skipped).toContain('0014_messaging.sql');
        const tables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema='messaging'`,
        );
        expect(tables.rows.map((r) => r.table_name)).toEqual(
          expect.arrayContaining([
            'conversations',
            'messages',
            'receipts',
            'notification_outbox',
            'ai_drafts',
          ]),
        );
        expect((await pool.query(`SELECT 'secret'::text AS body`)).rows[0]).toEqual({
          body: 'secret',
        });
        const actor = '00000000-0000-4000-8000-000000000101';
        const subject = '00000000-0000-4000-8000-000000000102';
        const stranger = '00000000-0000-4000-8000-000000000121';
        const connection = '00000000-0000-4000-8000-000000000103';
        const conversation = '00000000-0000-4000-8000-000000000104';
        for (const id of [actor, subject, stranger])
          await pool.query(
            `INSERT INTO iam.accounts(id,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_digest) VALUES($1::uuid,'x','x','k','enabled','registered','system',now(),now(),now(),$1::text)`,
            [id],
          );
        await pool.query(
          `INSERT INTO connection.connections(id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at) VALUES($1,$2,$3,$2,$3,'friends','accepted',7,now(),now(),now())`,
          [connection, actor, subject],
        );
        await pool.query(
          `INSERT INTO messaging.conversations(id,connection_id,connection_epoch,account_a,account_b,mode,created_at,updated_at) VALUES($1,$2,7,$3,$4,'friends',now(),now())`,
          [conversation, connection, actor, subject],
        );
        await expect(
          pool.query(
            `INSERT INTO messaging.conversations(id,connection_id,connection_epoch,account_a,account_b,mode,created_at,updated_at) VALUES($1,$2,8,$3,$4,'friends',now(),now())`,
            ['00000000-0000-4000-8000-000000000112', connection, actor, subject],
          ),
        ).rejects.toBeTruthy();
        await expect(
          pool.query(
            `INSERT INTO messaging.conversations(id,connection_id,connection_epoch,account_a,account_b,mode,state,created_at,updated_at) VALUES($1,$2,7,$3,$4,'friends','closed',now(),now())`,
            ['00000000-0000-4000-8000-000000000120', connection, actor, stranger],
          ),
        ).rejects.toBeTruthy();
        await pool.query(
          `INSERT INTO messaging.messages(id,conversation_id,sender_id,client_message_id,idempotency_key_digest,request_digest,server_sequence,body_ciphertext,body_nonce,body_key_id,body_hash,state,withdrawn_at,created_at) VALUES($1,$2,$3,$4,repeat('d',64),repeat('e',64),1,'opaque','nonce','k',repeat('a',64),'withdrawn',now(),now())`,
          [
            '00000000-0000-4000-8000-000000000105',
            conversation,
            actor,
            '00000000-0000-4000-8000-000000000106',
          ],
        );
        await expect(
          pool.query(
            `INSERT INTO messaging.messages(id,conversation_id,sender_id,client_message_id,idempotency_key_digest,request_digest,server_sequence,body_ciphertext,body_nonce,body_key_id,body_hash,created_at) VALUES($1,$2,$3,$4,repeat('f',64),repeat('g',64),1,'opaque','nonce','k',repeat('b',64),now())`,
            [
              '00000000-0000-4000-8000-000000000107',
              conversation,
              subject,
              '00000000-0000-4000-8000-000000000108',
            ],
          ),
        ).rejects.toBeTruthy();
        await pool.query(
          `INSERT INTO messaging.notification_outbox(id,conversation_id,message_id,recipient_id,event_type,payload_json,created_at) VALUES($1,$2,$3,$4,'message.wake',jsonb_build_object('conversation_id',($2::uuid)::text,'message_id',($3::uuid)::text,'event','message.wake'),now())`,
          [
            '00000000-0000-4000-8000-000000000109',
            conversation,
            '00000000-0000-4000-8000-000000000105',
            subject,
          ],
        );
        await expect(
          pool.query(
            `INSERT INTO messaging.notification_outbox(id,conversation_id,message_id,recipient_id,event_type,payload_json,created_at) VALUES($1,$2,$3,$4,'message.wake',jsonb_build_object('conversation_id',($2::uuid)::text,'message_id',($3::uuid)::text,'event','message.wake'),now())`,
            [
              '00000000-0000-4000-8000-000000000113',
              conversation,
              '00000000-0000-4000-8000-000000000105',
              actor,
            ],
          ),
        ).rejects.toBeTruthy();
        await expect(
          pool.query(
            `UPDATE messaging.messages SET idempotency_key_digest=repeat('f',64) WHERE id=$1`,
            ['00000000-0000-4000-8000-000000000105'],
          ),
        ).rejects.toBeTruthy();
        const key = Buffer.alloc(32, 7);
        const repository = new PgMessagingRepository(pool, {
          keyId: 'k',
          key,
          keys: new Map([['k', key]]),
          hmacKey: Buffer.alloc(32, 9),
        });
        const secondSubject = '00000000-0000-4000-8000-000000000114';
        const secondConnection = '00000000-0000-4000-8000-000000000115';
        const secondConversation = '00000000-0000-4000-8000-000000000116';
        await pool.query(
          `INSERT INTO iam.accounts(id,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_digest) VALUES($1::uuid,'x','x','k','enabled','registered','system',now(),now(),now(),$1::text)`,
          [secondSubject],
        );
        await pool.query(
          `INSERT INTO connection.connections(id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at) VALUES($1,$2,$3,$2,$3,'friends','accepted',7,now(),now(),now())`,
          [secondConnection, actor, secondSubject],
        );
        await pool.query(
          `INSERT INTO messaging.conversations(id,connection_id,connection_epoch,account_a,account_b,mode,created_at,updated_at) VALUES($1,$2,7,$3,$4,'friends',now(),now())`,
          [secondConversation, secondConnection, actor, secondSubject],
        );
        const hints: Array<Record<string, string>> = [];
        const runner = new MessagingWakeupRunner(repository, 'runner-a', {
          emit: async (hint) => {
            hints.push(hint);
          },
        });
        expect(await runner.runOnce()).toBe(1);
        expect(hints).toEqual([
          {
            conversation_id: conversation,
            message_id: '00000000-0000-4000-8000-000000000105',
            event: 'message.wake',
          },
        ]);
        expect(
          (
            await pool.query(`SELECT state FROM messaging.notification_outbox WHERE id=$1`, [
              '00000000-0000-4000-8000-000000000109',
            ])
          ).rows[0]?.state,
        ).toBe('dispatched');
        const sent = await repository.sendMessage({
          actorAccountId: actor,
          conversationId: conversation,
          clientMessageId: '00000000-0000-4000-8000-000000000201',
          body: 'first encrypted message',
          recipientId: subject,
          idempotencyKey: 'msg-idempotency-key-201',
        });
        await expect(repository.getInboxState(subject, conversation)).resolves.toMatchObject({
          last_message: { id: sent.id, body: 'first encrypted message', server_sequence: '2' },
          unread_count: 1,
        });
        await expect(repository.getConversationUnreadCount(subject, conversation)).resolves.toBe(1);
        const activity = await pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM messaging.conversations WHERE id=$1',
          [conversation],
        );
        expect(activity.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(
          new Date(sent.created_at).getTime(),
        );
        await expect(
          Promise.all([
            repository.markConversationRead(subject, conversation, sent.id),
            repository.markConversationRead(subject, conversation, sent.id),
          ]),
        ).resolves.toEqual([{ unreadCount: 0 }, { unreadCount: 0 }]);
        await expect(repository.getInboxState(subject, conversation)).resolves.toMatchObject({
          last_message: { id: sent.id, body: 'first encrypted message' },
          unread_count: 0,
        });
        await expect(repository.markConversationRead(actor, conversation, sent.id)).rejects.toThrow(
          'MESSAGE_NOT_FOUND',
        );
        await expect(
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000201',
            body: 'changed body',
            recipientId: subject,
            idempotencyKey: 'msg-idempotency-key-201',
          }),
        ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
        await expect(
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000202',
            body: 'different key owner payload',
            recipientId: subject,
            idempotencyKey: 'msg-idempotency-key-201',
          }),
        ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
        await expect(
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000201',
            body: 'first encrypted message',
            recipientId: subject,
            idempotencyKey: 'msg-idempotency-key-201',
          }),
        ).resolves.toMatchObject({ id: sent.id });
        const concurrentReplay = await Promise.all([
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000205',
            body: 'same concurrent body',
            recipientId: subject,
            idempotencyKey: 'msg-idempotency-key-205',
          }),
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000205',
            body: 'same concurrent body',
            recipientId: subject,
            idempotencyKey: 'msg-idempotency-key-205',
          }),
        ]);
        expect(concurrentReplay[0]!.id).toBe(concurrentReplay[1]!.id);
        const crossConversation = await Promise.allSettled([
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000206',
            body: 'cross conversation key',
            recipientId: subject,
            idempotencyKey: 'msg-cross-conversation-key',
          }),
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: secondConversation,
            clientMessageId: '00000000-0000-4000-8000-000000000207',
            body: 'cross conversation key',
            recipientId: secondSubject,
            idempotencyKey: 'msg-cross-conversation-key',
          }),
        ]);
        expect(crossConversation.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(crossConversation.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(
          (
            crossConversation.find(
              (result) => result.status === 'rejected',
            ) as PromiseRejectedResult
          ).reason,
        ).toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
        const concurrent = await Promise.all([
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000203',
            body: 'concurrent a',
            recipientId: subject,
            idempotencyKey: 'msg-idempotency-key-203',
          }),
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000204',
            body: 'concurrent b',
            recipientId: subject,
            idempotencyKey: 'msg-idempotency-key-204',
          }),
        ]);
        expect(new Set(concurrent.map((message) => message.server_sequence)).size).toBe(2);
        // A worker crash leaves a lease behind.  A different worker may take
        // it only after expiry, then emit the opaque wake and fence completion
        // with its new lease owner.
        await pool.query(
          `UPDATE messaging.notification_outbox SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE state='pending'`,
        );
        const staleMessage = await repository.sendMessage({
          actorAccountId: actor,
          conversationId: conversation,
          clientMessageId: '00000000-0000-4000-8000-000000000208',
          body: 'stale lease message',
          recipientId: subject,
          idempotencyKey: 'msg-stale-lease-key',
        });
        const staleRow = await pool.query<{ id: string }>(
          `SELECT id FROM messaging.notification_outbox WHERE message_id=$1`,
          [staleMessage.id],
        );
        expect(staleRow.rows[0]).toBeDefined();
        const claimedA = await repository.claimOutbox(1, 'worker-a');
        expect(claimedA[0]?.id).toBe(staleRow.rows[0]!.id);
        await pool.query(
          `UPDATE messaging.notification_outbox SET lease_until=now()-interval '1 second' WHERE id=$1`,
          [staleRow.rows[0]!.id],
        );
        const staleHints: Array<Record<string, string>> = [];
        const workerB = new MessagingWakeupRunner(repository, 'worker-b', {
          emit: async (hint) => {
            staleHints.push(hint);
          },
        });
        expect(await workerB.runOnce()).toBe(1);
        expect(staleHints).toEqual([
          {
            conversation_id: conversation,
            message_id: staleMessage.id,
            event: 'message.wake',
          },
        ]);
        expect(
          (
            await pool.query(
              `SELECT state,lease_owner FROM messaging.notification_outbox WHERE id=$1`,
              [staleRow.rows[0]!.id],
            )
          ).rows[0],
        ).toEqual({ state: 'dispatched', lease_owner: null });
        const page = await repository.history({
          actorAccountId: subject,
          conversationId: conversation,
          connectionEpoch: 7,
          limit: 2,
        });
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toEqual(expect.any(String));
        const replay = await repository.history({
          actorAccountId: subject,
          conversationId: conversation,
          connectionEpoch: 7,
          ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
          limit: 2,
        });
        expect(BigInt(replay.items[0]!.server_sequence)).toBeLessThan(
          BigInt(page.items[1]!.server_sequence),
        );
        await expect(
          repository.history({
            actorAccountId: subject,
            conversationId: conversation,
            connectionEpoch: 7,
            cursor: `${page.nextCursor!.slice(0, -1)}x`,
            limit: 2,
          }),
        ).rejects.toThrow('INVALID_CURSOR');
        await expect(
          repository.history({
            actorAccountId: actor,
            conversationId: conversation,
            connectionEpoch: 7,
            ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
            limit: 2,
          }),
        ).rejects.toThrow('INVALID_CURSOR');
        await expect(
          repository.history({
            actorAccountId: subject,
            conversationId: conversation,
            connectionEpoch: 8,
            ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
            limit: 2,
          }),
        ).rejects.toThrow('INVALID_CURSOR');
        const expiredPayload = JSON.stringify({
          v: subject,
          b: `${conversation}:7`,
          e: Date.now() - 1,
          value: page.items[1]!.server_sequence,
          id: page.items[1]!.id,
        });
        const expiredSignature = createHmac('sha256', Buffer.alloc(32, 9))
          .update(`messaging.cursor.v1\0${expiredPayload}`)
          .digest('hex');
        const expiredCursor = Buffer.from(
          JSON.stringify({ p: expiredPayload, sig: expiredSignature }),
        ).toString('base64url');
        await expect(
          repository.history({
            actorAccountId: subject,
            conversationId: conversation,
            connectionEpoch: 7,
            cursor: expiredCursor,
            limit: 2,
          }),
        ).rejects.toThrow('INVALID_CURSOR');
        await repository.receipt(subject, sent.id, 'delivered');
        await repository.receipt(subject, sent.id, 'read');
        await expect(repository.receipt(actor, sent.id, 'read')).rejects.toThrow();
        expect(
          (
            await pool.query(
              `SELECT payload_json ? 'body' AS contains_body FROM messaging.notification_outbox`,
            )
          ).rows[0]?.contains_body,
        ).toBe(false);
        const safetyRepository = new PgSafetyRepository(pool, {
          vaultKey: { keyId: 'safety-test', key: Buffer.alloc(32, 3) },
        });
        const connectionRepository = new PgConnectionRepository(pool, Buffer.alloc(32, 4));
        const messagingService = new MessagingService(
          repository,
          { check: async () => ({ allowed: true as const }) },
          {
            currentAccepted: async () => ({
              connectionId: connection,
              acceptedEpoch: 7,
              mode: 'friends' as const,
            }),
            isCurrentAccepted: async () => ({ mode: 'friends' as const }),
          },
          { suggest: async () => ({}) },
          { enqueue: async () => undefined },
          new SafetyService(safetyRepository, { capture: async () => null }),
        );
        const report = await messagingService.report(subject, sent.id, {
          subject_account_id: actor,
          category: 'harassment',
          idempotency_key: 'safety-message-report-201',
        });
        await expect(
          messagingService.report(actor, sent.id, {
            subject_account_id: actor,
            category: 'harassment',
            idempotency_key: 'safety-self-message-report',
          }),
        ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
        await expect(
          messagingService.report(secondSubject, sent.id, {
            subject_account_id: actor,
            category: 'harassment',
            idempotency_key: 'safety-nonparticipant-message-report',
          }),
        ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
        expect(
          (
            await pool.query(
              `SELECT count(*)::int AS count FROM safety.evidence_snapshots WHERE report_id=$1`,
              [report.id],
            )
          ).rows[0]?.count,
        ).toBe(1);
        await repository.withdraw(actor, sent.id);
        expect(
          (
            await pool.query(
              `SELECT count(*)::int AS count FROM safety.evidence_snapshots WHERE report_id=$1`,
              [report.id],
            )
          ).rows[0]?.count,
        ).toBe(1);
        const activeDraft = await repository.createAiDraft({
          actorAccountId: actor,
          conversationId: conversation,
          body: 'short lived encrypted draft',
          provider: 'test-provider',
          consent: { provider: true, retention: 'short_term' },
        });
        await expect(repository.getAiDraft(actor, activeDraft.id)).resolves.toMatchObject({
          draft: 'short lived encrypted draft',
        });
        const preBlockMessage = await repository.sendMessage({
          actorAccountId: actor,
          conversationId: conversation,
          clientMessageId: '00000000-0000-4000-8000-000000000211',
          body: 'pending before block',
          recipientId: subject,
          idempotencyKey: 'msg-pending-before-block-key',
        });
        const blockRace = await Promise.allSettled([
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: secondConversation,
            clientMessageId: '00000000-0000-4000-8000-000000000209',
            body: 'block race',
            recipientId: secondSubject,
            idempotencyKey: 'msg-block-race-key',
          }),
          safetyRepository.createBlock({
            blockerAccountId: actor,
            blockedAccountId: secondSubject,
            reason: 'unwanted_contact',
            idempotencyKey: 'safety-block-race-key',
          }),
        ]);
        for (const result of blockRace) {
          if (result.status === 'rejected') expect(String(result.reason)).not.toContain('40P01');
        }
        const disconnectRace = await Promise.allSettled([
          repository.sendMessage({
            actorAccountId: actor,
            conversationId: conversation,
            clientMessageId: '00000000-0000-4000-8000-000000000210',
            body: 'disconnect race',
            recipientId: subject,
            idempotencyKey: 'msg-disconnect-race-key',
          }),
          connectionRepository.transition({
            connectionId: connection,
            actorAccountId: subject,
            action: 'disconnect',
            idempotencyKey: 'connection-disconnect-race-key',
          }),
        ]);
        for (const result of disconnectRace) {
          if (result.status === 'rejected') expect(String(result.reason)).not.toContain('40P01');
        }
        const reportAfterDisconnect = await messagingService.report(subject, sent.id, {
          subject_account_id: actor,
          category: 'other',
          idempotency_key: 'safety-message-report-after-disconnect',
        });
        expect(reportAfterDisconnect.id).toEqual(expect.any(String));
        await pool.query(
          `INSERT INTO safety.blocks(id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at) VALUES($1,$2,$3,'unwanted_contact',repeat('d',64),repeat('e',64),'active',now())`,
          ['00000000-0000-4000-8000-000000000110', actor, subject],
        );
        // Safety reporting remains available after the live pair is blocked;
        // it is authorized from the historical participant relationship.
        const reportAfterBlock = await messagingService.report(subject, sent.id, {
          subject_account_id: actor,
          category: 'privacy_violation',
          idempotency_key: 'safety-message-report-after-block',
        });
        expect(reportAfterBlock.id).toEqual(expect.any(String));
        await expect(
          pool.query(
            `INSERT INTO messaging.messages(id,conversation_id,sender_id,client_message_id,idempotency_key_digest,request_digest,server_sequence,body_ciphertext,body_nonce,body_key_id,body_hash,created_at) VALUES($1,$2,$3,$4,repeat('h',64),repeat('i',64),999,'opaque','nonce','k',repeat('c',64),now())`,
            [
              '00000000-0000-4000-8000-000000000118',
              conversation,
              actor,
              '00000000-0000-4000-8000-000000000119',
            ],
          ),
        ).rejects.toBeTruthy();
        await expect(
          pool.query(
            `UPDATE messaging.receipts SET read_at=now() WHERE message_id=$1 AND viewer_id=$2`,
            [sent.id, subject],
          ),
        ).rejects.toBeTruthy();
        const blockedPending = await pool.query<{ id: string }>(
          `SELECT id FROM messaging.notification_outbox WHERE state='pending' AND message_id=$1`,
          [preBlockMessage.id],
        );
        expect(blockedPending.rows).toHaveLength(1);
        await expect(
          pool.query(
            `UPDATE messaging.notification_outbox SET state='dispatched',dispatched_at=now() WHERE id=$1`,
            [blockedPending.rows[0]!.id],
          ),
        ).rejects.toBeTruthy();
        await pool.query(
          `INSERT INTO messaging.ai_drafts(id,conversation_id,owner_id,ciphertext,nonce,key_id,provider,consent_json,expires_at,created_at) VALUES($1,$2,$3,'cipher','nonce','k','test-provider','{"provider":true,"retention":"short_term"}'::jsonb,now()-interval '1 minute',now()-interval '2 minutes')`,
          ['00000000-0000-4000-8000-000000000111', conversation, actor],
        );
        const emittedBeforeBlock = hints.length;
        await runner.runOnce();
        expect(hints).toHaveLength(emittedBeforeBlock);
        expect(
          (
            await pool.query(
              `SELECT deleted_at IS NOT NULL AS expired FROM messaging.ai_drafts WHERE id=$1`,
              ['00000000-0000-4000-8000-000000000111'],
            )
          ).rows[0]?.expired,
        ).toBe(true);
        expect(
          (
            await pool.query(
              `SELECT count(*)::int AS count FROM messaging.notification_outbox WHERE state='cancelled'`,
            )
          ).rows[0]?.count,
        ).toBeGreaterThanOrEqual(5);
        expect(await migrationRunner.down()).toBe('0014_messaging.sql');
        await migrationRunner.up();
      } finally {
        await pool.end();
      }
    });
  }, 180_000);
});
