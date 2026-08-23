export type MessageOwnership = 'incoming' | 'outgoing';
export type ConversationKind = 'direct' | 'circle';
export type ConversationFilter = 'all' | 'private' | 'circles';

export interface ConversationProjection {
  id: string;
  mode?: string;
  conversation_type?: ConversationKind;
  participant_display_name?: string | null;
  circle_context?: { name?: string | null } | null;
}

export function conversationKind(conversation: ConversationProjection): ConversationKind {
  return conversation.conversation_type === 'circle' ? 'circle' : 'direct';
}

export function conversationTitle(conversation: ConversationProjection): string {
  if (conversationKind(conversation) === 'circle') {
    return conversation.circle_context?.name?.trim() || 'Circle conversation';
  }
  return conversation.participant_display_name?.trim() || 'Private conversation';
}

export function conversationInitials(conversation: ConversationProjection): string {
  const words = conversationTitle(conversation).split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((word) => word[0]?.toLocaleUpperCase() ?? '').join('') || '•';
}

export function filterConversations<T extends ConversationProjection>(
  conversations: readonly T[],
  filter: ConversationFilter,
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  return conversations.filter((conversation) => {
    const kind = conversationKind(conversation);
    if (filter === 'private' && kind !== 'direct') return false;
    if (filter === 'circles' && kind !== 'circle') return false;
    if (!normalized) return true;
    return `${conversationTitle(conversation)} ${conversation.mode ?? ''}`
      .toLocaleLowerCase()
      .includes(normalized);
  });
}

export function conversationResponse<T>(input: {
  selectedId: string | null;
  generation: number;
  responseId: string;
  responseGeneration: number;
  items: T[];
}): T[] | null {
  if (input.selectedId !== input.responseId || input.generation !== input.responseGeneration)
    return null;
  return input.items;
}

export function messageOwnership(
  senderAccountId: string,
  participantAccountId: string,
): MessageOwnership {
  return senderAccountId === participantAccountId ? 'incoming' : 'outgoing';
}

export function messageAction(
  senderAccountId: string,
  participantAccountId: string,
): 'report' | 'withdraw' {
  return messageOwnership(senderAccountId, participantAccountId) === 'incoming'
    ? 'report'
    : 'withdraw';
}
