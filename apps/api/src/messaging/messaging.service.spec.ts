import { describe, expect, it, vi } from 'vitest';
import { MessagingService } from './messaging.service.js';

const conversation = {
  id: '00000000-0000-0000-0000-000000000001',
  connection_id: '00000000-0000-0000-0000-000000000002',
  connection_epoch: 3,
  mode: 'friends' as const,
  participant_account_id: '00000000-0000-0000-0000-000000000003',
  opening_reference: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
function fixture() {
  const repo = {
    getConnectionParticipants: vi.fn().mockResolvedValue({
      subjectAccountId: conversation.participant_account_id,
      mode: 'friends',
    }),
    createConversation: vi.fn().mockResolvedValue(conversation),
    getConversation: vi.fn().mockResolvedValue(conversation),
    getMessageContext: vi
      .fn()
      .mockResolvedValue({ conversation, senderAccountId: conversation.participant_account_id }),
    getMessageEvidence: vi.fn().mockResolvedValue({
      subjectAccountId: conversation.participant_account_id,
      sourceVersion: '1',
      moderationState: 'visible',
    }),
    getReportableMessageEvidence: vi.fn().mockResolvedValue({
      subjectAccountId: conversation.participant_account_id,
      sourceVersion: '1',
      moderationState: 'visible',
    }),
    listConversations: vi.fn().mockResolvedValue({ items: [conversation], nextCursor: null }),
    getInboxState: vi.fn().mockResolvedValue({
      last_message: {
        id: '00000000-0000-0000-0000-000000000004',
        conversation_id: conversation.id,
        sender_account_id: conversation.participant_account_id,
        client_message_id: '00000000-0000-4000-8000-000000000006',
        server_sequence: '1',
        body: 'hello',
        state: 'active',
        created_at: new Date().toISOString(),
        withdrawn_at: null,
      },
      unread_count: 1,
    }),
    getConversationUnreadCount: vi.fn().mockResolvedValue(1),
    markConversationRead: vi.fn().mockResolvedValue({ unreadCount: 0 }),
    history: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    sendMessage: vi.fn().mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000004',
      conversation_id: conversation.id,
      sender_account_id: 'actor',
      client_message_id: '00000000-0000-0000-0000-000000000005',
      server_sequence: '1',
      body: 'hello',
      state: 'active',
      created_at: new Date().toISOString(),
      withdrawn_at: null,
    }),
    withdraw: vi.fn(),
    receipt: vi.fn(),
    createAiDraft: vi.fn(),
    getAiDraft: vi.fn(),
    getAiDraftConversation: vi.fn().mockResolvedValue(conversation),
    deleteAiDraft: vi.fn(),
  };
  const gate = { check: vi.fn().mockResolvedValue({ allowed: true }) };
  const connections = { isCurrentAccepted: vi.fn().mockResolvedValue({ mode: 'friends' }) };
  const ai = {
    suggest: vi.fn().mockResolvedValue({ draft: 'hi', provider: 'test', schema_version: 1 }),
  };
  const safety = { reportWithSnapshot: vi.fn() };
  const wakeup = { enqueue: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new MessagingService(
      repo as never,
      gate as never,
      connections as never,
      ai as never,
      wakeup as never,
      safety as never,
    ),
    repo,
    gate,
    connections,
    ai,
    safety,
  };
}

describe('MSG-01', () => {
  it('conversation_requires_current_connection_and_pair_gate', async () => {
    const f = fixture();
    await f.service.detail('actor', conversation.id);
    expect(f.connections.isCurrentAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: conversation.connection_id, acceptedEpoch: 3 }),
    );
    expect(f.gate.check).toHaveBeenCalledWith(
      expect.objectContaining({
        requireConnection: true,
        connectionId: conversation.connection_id,
        acceptedEpoch: 3,
      }),
    );
  });
  it('message_send_is_ordered_idempotent_and_cursor_recoverable', async () => {
    const f = fixture();
    const sent = await f.service.send(
      'actor',
      conversation.id,
      {
        client_message_id: '00000000-0000-0000-0000-000000000005',
        body: 'hello',
      },
      'idempotency-key-123456',
    );
    expect(sent.server_sequence).toBe('1');
    expect(f.repo.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: conversation.participant_account_id }),
    );
  });
  it('projects authorized inbox summaries and a bounded unread total', async () => {
    const f = fixture();
    await expect(f.service.list('actor', { limit: 50 })).resolves.toMatchObject({
      items: [{ id: conversation.id, unread_count: 1, last_message: { body: 'hello' } }],
    });
    await expect(f.service.unreadCount('actor')).resolves.toEqual({
      unread_count: 1,
      capped: false,
    });
    expect(f.repo.getInboxState).toHaveBeenCalledWith('actor', conversation.id);
    expect(f.repo.getConversationUnreadCount).toHaveBeenCalledWith('actor', conversation.id);
  });
  it('marks only a server-bound incoming message and rechecks the final gate', async () => {
    const f = fixture();
    await expect(
      f.service.markConversationRead('actor', conversation.id, {
        through_message_id: '00000000-0000-0000-0000-000000000004',
      }),
    ).resolves.toEqual({ unread_count: 0 });
    expect(f.repo.markConversationRead).toHaveBeenCalledWith(
      'actor',
      conversation.id,
      '00000000-0000-0000-0000-000000000004',
    );
    expect(f.connections.isCurrentAccepted).toHaveBeenCalledTimes(2);
  });
  it('block_closes_realtime_and_prevents_new_message_or_notification', async () => {
    const f = fixture();
    f.connections.isCurrentAccepted
      .mockResolvedValueOnce({ mode: 'friends' })
      .mockResolvedValue(null);
    await f.service.subscribe('actor', conversation.id);
    await expect(
      f.service.send(
        'actor',
        conversation.id,
        {
          client_message_id: '00000000-0000-0000-0000-000000000005',
          body: 'hello',
        },
        'idempotency-key-123456',
      ),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(f.repo.sendMessage).not.toHaveBeenCalled();
  });
  it('ai_suggestion_never_creates_or_sends_a_message', async () => {
    const f = fixture();
    f.repo.createAiDraft.mockResolvedValue({
      id: conversation.id,
      provider: 'test',
      expiresAt: new Date(),
      createdAt: new Date(),
      draft: 'hi',
    });
    await f.service.draft('actor', conversation.id, {
      consent: { provider: true, retention: 'short_term' },
    });
    expect(f.repo.sendMessage).not.toHaveBeenCalled();
    expect(f.repo.createAiDraft).toHaveBeenCalled();
  });
  it('reported_then_withdrawn_message_keeps_immutable_evidence', async () => {
    const f = fixture();
    f.safety.reportWithSnapshot.mockResolvedValue({ id: 'report' });
    await f.service.report('actor', '00000000-0000-0000-0000-000000000004', {
      subject_account_id: conversation.participant_account_id,
      category: 'harassment',
      idempotency_key: 'report-key-123456',
    });
    expect(f.safety.reportWithSnapshot).toHaveBeenCalledWith(
      'actor',
      expect.objectContaining({ target_type: 'message' }),
      expect.objectContaining({
        safeMetadata: { message_version: '1', moderation_state: 'visible' },
      }),
    );
    expect(f.repo.getReportableMessageEvidence).toHaveBeenCalledWith('actor', expect.any(String));
    expect(f.gate.check).not.toHaveBeenCalled();
  });
});
