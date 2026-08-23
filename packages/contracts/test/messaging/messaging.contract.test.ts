import { describe, expect, it } from 'vitest';
import {
  aiDraftRequestSchema,
  conversationInboxResponseSchema,
  conversationReadSchema,
  conversationCreateSchema,
  messageSendSchema,
  realtimeHintSchema,
} from '../../src/messaging/index.js';
describe('messaging contracts', () => {
  it('rejects unknown fields and requires explicit AI consent', () => {
    expect(
      messageSendSchema.safeParse({
        client_message_id: crypto.randomUUID(),
        body: 'x',
        sender_id: 'spoof',
      }).success,
    ).toBe(false);
    expect(
      aiDraftRequestSchema.safeParse({ consent: { provider: true, retention: 'long' } }).success,
    ).toBe(false);
  });
  it('binds opening reference to delivery revision/hash shape and wake is opaque', () => {
    const valid = conversationCreateSchema.safeParse({
      connection_id: crypto.randomUUID(),
      connection_epoch: 1,
      opening_reference: {
        delivery_id: crypto.randomUUID(),
        revision: 1,
        source_hash: 'a'.repeat(64),
      },
    });
    expect(valid.success).toBe(true);
    expect(
      realtimeHintSchema.safeParse({
        conversation_id: crypto.randomUUID(),
        message_id: crypto.randomUUID(),
        event: 'message.wake',
        body: 'secret',
      }).success,
    ).toBe(false);
  });
  it('binds conversation read to an incoming message id and closes the inbox projection', () => {
    expect(
      conversationReadSchema.safeParse({ through_message_id: crypto.randomUUID() }).success,
    ).toBe(true);
    expect(
      conversationReadSchema.safeParse({
        through_message_id: crypto.randomUUID(),
        through_sequence: '999',
      }).success,
    ).toBe(false);
    const now = new Date().toISOString();
    expect(
      conversationInboxResponseSchema.safeParse({
        id: crypto.randomUUID(),
        connection_id: crypto.randomUUID(),
        connection_epoch: 1,
        mode: 'friends',
        participant_account_id: crypto.randomUUID(),
        opening_reference: null,
        opening_context: null,
        created_at: now,
        updated_at: now,
        unread_count: 1,
        last_message: {
          id: crypto.randomUUID(),
          conversation_id: crypto.randomUUID(),
          sender_account_id: crypto.randomUUID(),
          client_message_id: crypto.randomUUID(),
          server_sequence: '1',
          body: 'safe inbox preview',
          state: 'active',
          created_at: now,
          withdrawn_at: null,
        },
      }).success,
    ).toBe(true);
  });
});
