import { z } from 'zod';
import { idSchema } from '../ids.js';
import { connectionModeSchema } from '../connection/enums.js';

export const conversationCreateSchema = z
  .object({
    connection_id: idSchema,
    connection_epoch: z.number().int().nonnegative(),
    opening_reference: z
      .object({
        delivery_id: idSchema,
        revision: z.number().int().positive(),
        source_hash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;

export const messageSendSchema = z
  .object({
    client_message_id: z.string().uuid(),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export type MessageSend = z.infer<typeof messageSendSchema>;

export const messageHistoryQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,1024}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

export const receiptSchema = z
  .object({ delivered: z.boolean().optional(), read: z.boolean().optional() })
  .strict();
export const conversationReadSchema = z.object({ through_message_id: idSchema }).strict();
export type ConversationRead = z.infer<typeof conversationReadSchema>;
export const aiDraftRequestSchema = z
  .object({
    context: z.string().trim().max(2000).optional(),
    consent: z.object({ provider: z.literal(true), retention: z.literal('short_term') }).strict(),
  })
  .strict();
export type AiDraftRequest = z.infer<typeof aiDraftRequestSchema>;
export const aiSuggestionOutputSchema = z
  .object({
    draft: z.string().trim().min(1).max(2000),
    provider: z.string().min(1).max(64),
    schema_version: z.literal(1),
  })
  .strict();
export const messageReportRequestSchema = z
  .object({
    subject_account_id: idSchema,
    category: z.enum([
      'harassment',
      'threats',
      'sexual_content',
      'hate_or_discrimination',
      'scam_or_fraud',
      'privacy_violation',
      'other',
    ]),
    idempotency_key: z.string().min(16).max(128),
  })
  .strict();
export const realtimeHintSchema = z
  .object({ conversation_id: idSchema, message_id: idSchema, event: z.literal('message.wake') })
  .strict();
export type MessagingRealtimeHint = z.infer<typeof realtimeHintSchema>;

export interface MessagingConversation {
  id: string;
  connection_id: string;
  connection_epoch: number;
  mode: z.infer<typeof connectionModeSchema>;
  participant_account_id: string;
  opening_reference: { delivery_id: string; revision: number; source_hash: string } | null;
  /** Safe PVL metadata only; never includes opening letter plaintext. */
  opening_context: {
    status: 'delivered_reference';
    original_locale: string | null;
    machine_translation_available: boolean;
  } | null;
  created_at: string;
  updated_at: string;
}
export interface MessagingMessage {
  id: string;
  conversation_id: string;
  sender_account_id: string;
  client_message_id: string;
  server_sequence: string;
  body: string | null;
  state: 'active' | 'withdrawn';
  created_at: string;
  withdrawn_at: string | null;
}
export interface MessagingInboxState {
  last_message: MessagingMessage | null;
  unread_count: number;
}
export interface MessagingMessageEvidence {
  subjectAccountId: string;
  sourceVersion: string;
  moderationState: 'visible' | 'removed' | 'quarantined';
}
export type MessageReportRequest = z.infer<typeof messageReportRequestSchema>;
export interface MessagingSendInput {
  actorAccountId: string;
  conversationId: string;
  clientMessageId: string;
  body: string;
  recipientId: string;
  idempotencyKey: string;
}
export interface MessagingHistoryInput {
  actorAccountId: string;
  conversationId: string;
  cursor?: string;
  limit: number;
}
export interface MessagingConversationCreateInput {
  actorAccountId: string;
  subjectAccountId: string;
  connectionId: string;
  connectionEpoch: number;
  mode: z.infer<typeof connectionModeSchema>;
  openingReference?: { deliveryId: string; revision: number; sourceHash: string };
}
export interface MessagingDraftInput {
  actorAccountId: string;
  conversationId: string;
  body: string;
  provider: string;
  consent: z.infer<typeof aiDraftRequestSchema>['consent'];
}
export interface MessagingDraft {
  id: string;
  provider: string;
  expiresAt: Date;
  createdAt: Date;
  draft: string;
}

export const conversationResponseSchema = z
  .object({
    id: idSchema,
    connection_id: idSchema,
    connection_epoch: z.number().int().nonnegative(),
    mode: connectionModeSchema,
    participant_account_id: idSchema,
    opening_reference: z
      .object({
        delivery_id: idSchema,
        revision: z.number().int().positive(),
        source_hash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
    opening_context: z
      .object({
        status: z.literal('delivered_reference'),
        original_locale: z.string().min(2).max(32).nullable(),
        machine_translation_available: z.boolean(),
      })
      .strict()
      .nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const messageResponseSchema = z
  .object({
    id: idSchema,
    conversation_id: idSchema,
    sender_account_id: idSchema,
    client_message_id: z.string().uuid(),
    server_sequence: z.string().regex(/^\d+$/),
    body: z.string().nullable(),
    state: z.enum(['active', 'withdrawn']),
    created_at: z.string().datetime({ offset: true }),
    withdrawn_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const conversationInboxResponseSchema = conversationResponseSchema.extend({
  last_message: messageResponseSchema.nullable(),
  unread_count: z.number().int().nonnegative(),
});

export const messagingUnreadCountResponseSchema = z
  .object({ unread_count: z.number().int().nonnegative(), capped: z.boolean() })
  .strict();

export interface MessagingConnectionPort {
  currentAccepted(
    sender: string,
    recipient: string,
  ): Promise<{
    connectionId: string;
    acceptedEpoch: number;
    mode: z.infer<typeof connectionModeSchema>;
  } | null>;
  isCurrentAccepted(input: {
    connectionId: string;
    acceptedEpoch: number;
    senderAccountId: string;
    recipientAccountId: string;
  }): Promise<{ mode: z.infer<typeof connectionModeSchema> } | null>;
}
export interface MessagingRepositoryPort {
  getConnectionParticipants(
    actorAccountId: string,
    connectionId: string,
    epoch: number,
  ): Promise<{ subjectAccountId: string; mode: z.infer<typeof connectionModeSchema> } | null>;
  createConversation(input: MessagingConversationCreateInput): Promise<MessagingConversation>;
  getConversation(
    actorAccountId: string,
    conversationId: string,
  ): Promise<MessagingConversation | null>;
  getMessageContext(
    actorAccountId: string,
    messageId: string,
  ): Promise<{ conversation: MessagingConversation; senderAccountId: string } | null>;
  getMessageEvidence(
    actorAccountId: string,
    messageId: string,
  ): Promise<MessagingMessageEvidence | null>;
  /**
   * Reporting is a safety exception to the live connection gate.  The
   * repository must authorize this from the immutable conversation/message
   * relationship in one transaction and return metadata only.
   */
  getReportableMessageEvidence(
    actorAccountId: string,
    messageId: string,
  ): Promise<MessagingMessageEvidence | null>;
  listConversations(
    actorAccountId: string,
    query: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: MessagingConversation[]; nextCursor: string | null }>;
  getInboxState(
    actorAccountId: string,
    conversationId: string,
  ): Promise<MessagingInboxState | null>;
  getConversationUnreadCount(
    actorAccountId: string,
    conversationId: string,
  ): Promise<number | null>;
  markConversationRead(
    actorAccountId: string,
    conversationId: string,
    throughMessageId: string,
  ): Promise<{ unreadCount: number }>;
  sendMessage(input: MessagingSendInput): Promise<MessagingMessage>;
  history(
    input: MessagingHistoryInput & { connectionEpoch: number },
  ): Promise<{ items: MessagingMessage[]; nextCursor: string | null }>;
  withdraw(actorAccountId: string, messageId: string): Promise<MessagingMessage>;
  receipt(actorAccountId: string, messageId: string, kind: 'delivered' | 'read'): Promise<void>;
  createAiDraft(input: MessagingDraftInput): Promise<MessagingDraft>;
  getAiDraft(actorAccountId: string, draftId: string): Promise<MessagingDraft | null>;
  getAiDraftConversation(
    actorAccountId: string,
    draftId: string,
  ): Promise<MessagingConversation | null>;
  deleteAiDraft(actorAccountId: string, draftId: string): Promise<void>;
}
export interface MessagingWakeupPort {
  enqueue(conversationId: string, messageId: string): Promise<void>;
  close?(): Promise<void>;
}
export interface MessagingOutboxRepositoryPort {
  claimOutbox(
    limit: number,
    leaseOwner: string,
  ): Promise<Array<{ id: string; conversationId: string; messageId: string; recipientId: string }>>;
  authorizeOutbox(
    id: string,
    leaseOwner: string,
  ): Promise<
    | { status: 'authorized'; hint: MessagingRealtimeHint }
    | { status: 'cancelled' }
    | { status: 'retry' }
  >;
  completeOutbox(id: string, leaseOwner: string): Promise<'dispatched' | 'retry'>;
  failOutbox(id: string, leaseOwner: string, errorCode: string): Promise<'retry' | 'stale'>;
  releaseStaleOutbox(leaseOwner: string): Promise<number>;
  reapExpiredAiDrafts(limit: number): Promise<number>;
}
export interface MessagingHintDispatchPort {
  emit(hint: MessagingRealtimeHint): Promise<void>;
  close?(): Promise<void>;
}
export const MESSAGING_REPOSITORY = 'MESSAGING_REPOSITORY' as const;
export const MESSAGING_WAKEUP = 'MESSAGING_WAKEUP' as const;
export const MESSAGING_CONNECTION = 'MESSAGING_CONNECTION' as const;
