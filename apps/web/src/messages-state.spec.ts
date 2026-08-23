import { describe, expect, it } from 'vitest';
import {
  conversationKind,
  conversationResponse,
  conversationTitle,
  filterConversations,
  messageAction,
  messageOwnership,
} from './messages-state.js';

describe('messages conversation state guards', () => {
  it('drops a delayed A response after switching to B', () => {
    expect(
      conversationResponse({
        selectedId: 'conversation-b',
        generation: 2,
        responseId: 'conversation-a',
        responseGeneration: 1,
        items: ['stale-a'],
      }),
    ).toBeNull();
    expect(
      conversationResponse({
        selectedId: 'conversation-b',
        generation: 2,
        responseId: 'conversation-b',
        responseGeneration: 2,
        items: ['current-b'],
      }),
    ).toEqual(['current-b']);
  });

  it('only exposes report for incoming and withdraw for outgoing messages', () => {
    expect(messageOwnership('participant', 'participant')).toBe('incoming');
    expect(messageAction('participant', 'participant')).toBe('report');
    expect(messageOwnership('viewer', 'participant')).toBe('outgoing');
    expect(messageAction('viewer', 'participant')).toBe('withdraw');
  });

  it('keeps the accepted direct contract backwards compatible and recognises circle summaries', () => {
    expect(conversationKind({ id: 'direct' })).toBe('direct');
    expect(conversationKind({ id: 'circle', conversation_type: 'circle' })).toBe('circle');
    expect(
      conversationTitle({
        id: 'direct',
        participant_display_name: ' Nadia ',
      }),
    ).toBe('Nadia');
    expect(
      conversationTitle({
        id: 'circle',
        conversation_type: 'circle',
        circle_context: { name: 'Books & Libraries' },
      }),
    ).toBe('Books & Libraries');
  });

  it('filters the unified inbox by kind and a normalized title or mode query', () => {
    const conversations = [
      {
        id: 'direct-friends',
        mode: 'friends',
        participant_display_name: 'Nadia',
      },
      {
        id: 'circle-books',
        mode: 'circles',
        conversation_type: 'circle' as const,
        circle_context: { name: 'Books & Libraries' },
      },
    ];

    expect(filterConversations(conversations, 'private', '')).toEqual([conversations[0]]);
    expect(filterConversations(conversations, 'circles', '')).toEqual([conversations[1]]);
    expect(filterConversations(conversations, 'all', '  LIBRARIES ')).toEqual([conversations[1]]);
    expect(filterConversations(conversations, 'all', 'friends')).toEqual([conversations[0]]);
  });
});
