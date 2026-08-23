import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type AiDraftRequest,
  type InteractionGatePort,
  type MessagingRepositoryPort,
  type MessagingConnectionPort,
  type MessageSend,
  type ConversationCreate,
  type ConversationRead,
  type MessagingConversation,
  type MessagingInboxState,
  type ConnectionMode,
  type MessageReportRequest,
  type MessageHistoryQuery,
  canonicalEvidenceSnapshotSchema,
  aiSuggestionOutputSchema,
} from '@wai/contracts';
import { CONNECTION_GATE } from '../connection/connection.tokens.js';
import { PRIVATE_DELIVERY_CONNECTION } from '../connection/connection.tokens.js';
import { SafetyService } from '../safety/safety.service.js';
import {
  MESSAGING_REPOSITORY,
  MESSAGING_AI_PROVIDER,
  MESSAGING_WAKEUP,
} from './messaging.tokens.js';

export interface AiSuggestionProvider {
  suggest(input: { context?: string; mode: string }): Promise<unknown>;
}
const notFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: 'Conversation not found' });

@Injectable()
export class MessagingService {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repo: MessagingRepositoryPort,
    @Inject(CONNECTION_GATE) private readonly gate: InteractionGatePort,
    @Inject(PRIVATE_DELIVERY_CONNECTION) private readonly connections: MessagingConnectionPort,
    @Inject(MESSAGING_AI_PROVIDER) private readonly ai: AiSuggestionProvider,
    @Inject(MESSAGING_WAKEUP)
    private readonly wakeup: { enqueue(conversationId: string, messageId: string): Promise<void> },
    @Inject(SafetyService) private readonly safety: Pick<SafetyService, 'reportWithSnapshot'>,
  ) {}

  async create(actor: string, input: ConversationCreate) {
    const participant = await this.repo.getConnectionParticipants(
      actor,
      input.connection_id,
      input.connection_epoch,
    );
    if (
      !participant ||
      !(await this.allowed(
        actor,
        participant.subjectAccountId,
        participant.mode,
        input.connection_id,
        input.connection_epoch,
      ))
    )
      throw notFound();
    try {
      return await this.repo.createConversation({
        actorAccountId: actor,
        subjectAccountId: participant.subjectAccountId,
        connectionId: input.connection_id,
        connectionEpoch: input.connection_epoch,
        mode: participant.mode,
        ...(input.opening_reference
          ? {
              openingReference: {
                deliveryId: input.opening_reference.delivery_id,
                revision: input.opening_reference.revision,
                sourceHash: input.opening_reference.source_hash,
              },
            }
          : {}),
      });
    } catch (e) {
      throw this.map(e);
    }
  }
  async list(actor: string, query: MessageHistoryQuery) {
    try {
      const visible: Array<MessagingConversation & MessagingInboxState> = [];
      let cursor = query.cursor;
      let nextCursor: string | null = null;
      let scanned = 0;
      while (visible.length < query.limit && scanned < 1000) {
        const page = await this.repo.listConversations(actor, {
          ...(cursor ? { cursor } : {}),
          // One row per policy check keeps the signed cursor boundary aligned
          // with the last row examined when stale policy rows are skipped.
          limit: 1,
        });
        for (const item of page.items) {
          scanned += 1;
          if (!(await this.finalGate(actor, item))) continue;
          const inbox = await this.repo.getInboxState(actor, item.id);
          if (inbox && (await this.finalGate(actor, item))) visible.push({ ...item, ...inbox });
        }
        nextCursor = page.nextCursor;
        if (!nextCursor || page.items.length === 0 || visible.length === query.limit) break;
        cursor = nextCursor;
      }
      return { items: visible, next_cursor: nextCursor };
    } catch (e) {
      throw this.map(e);
    }
  }
  async unreadCount(actor: string) {
    try {
      let cursor: string | undefined;
      let unreadCount = 0;
      let scanned = 0;
      let hasMore = false;
      while (scanned < 1000 && unreadCount < 99) {
        const page = await this.repo.listConversations(actor, {
          ...(cursor ? { cursor } : {}),
          limit: 25,
        });
        for (const item of page.items) {
          scanned += 1;
          if (!(await this.finalGate(actor, item))) continue;
          const unread = await this.repo.getConversationUnreadCount(actor, item.id);
          if (unread !== null && (await this.finalGate(actor, item))) unreadCount += unread;
          if (unreadCount >= 99 || scanned >= 1000) break;
        }
        hasMore = page.nextCursor !== null;
        if (!page.nextCursor || page.items.length === 0 || unreadCount >= 99 || scanned >= 1000)
          break;
        cursor = page.nextCursor;
      }
      return { unread_count: Math.min(unreadCount, 99), capped: unreadCount >= 99 || hasMore };
    } catch (error) {
      throw this.map(error);
    }
  }
  async detail(actor: string, id: string) {
    const c = await this.repo.getConversation(actor, id);
    if (!c || !(await this.finalGate(actor, c))) throw notFound();
    return c;
  }
  async history(actor: string, id: string, query: MessageHistoryQuery) {
    const c = await this.requireConversation(actor, id);
    try {
      return await this.repo.history({
        actorAccountId: actor,
        conversationId: id,
        connectionEpoch: c.connection_epoch,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit,
      });
    } catch (e) {
      throw this.map(e);
    }
  }
  async send(actor: string, id: string, input: MessageSend, idempotencyKey: string) {
    const c = await this.requireConversation(actor, id);
    const body = input.body;
    try {
      const result = await this.repo.sendMessage({
        actorAccountId: actor,
        conversationId: id,
        clientMessageId: input.client_message_id,
        body,
        recipientId: c.participant_account_id,
        idempotencyKey,
      });
      await this.wakeup.enqueue(result.conversation_id, result.id).catch(() => undefined);
      return result;
    } catch (e) {
      throw this.map(e);
    }
  }
  async withdraw(actor: string, id: string) {
    const context = await this.repo.getMessageContext(actor, id);
    if (
      !context ||
      context.senderAccountId !== actor ||
      !(await this.finalGate(actor, context.conversation))
    )
      throw notFound();
    try {
      return await this.repo.withdraw(actor, id);
    } catch (e) {
      throw this.map(e);
    }
  }
  async receipt(actor: string, id: string, kind: 'delivered' | 'read') {
    const context = await this.repo.getMessageContext(actor, id);
    if (
      !context ||
      context.senderAccountId === actor ||
      !(await this.finalGate(actor, context.conversation))
    )
      throw notFound();
    try {
      await this.repo.receipt(actor, id, kind);
      return { ok: true };
    } catch (e) {
      throw this.map(e);
    }
  }
  async markConversationRead(actor: string, id: string, input: ConversationRead) {
    const conversation = await this.requireConversation(actor, id);
    let result: { unreadCount: number };
    try {
      result = await this.repo.markConversationRead(actor, id, input.through_message_id);
    } catch (error) {
      throw this.map(error);
    }
    if (!(await this.finalGate(actor, conversation))) throw notFound();
    return { unread_count: result.unreadCount };
  }
  async report(actor: string, messageId: string, input: MessageReportRequest) {
    // Reporting is the deliberate safety exception to the live connection
    // gate.  The repository performs participant/sender authorization and
    // captures only immutable metadata in one transaction, so a disconnect
    // or block cannot erase the ability to report received history.
    const evidence = await this.repo.getReportableMessageEvidence(actor, messageId);
    if (!evidence || evidence.subjectAccountId !== input.subject_account_id) throw notFound();
    const snapshot = canonicalEvidenceSnapshotSchema.parse({
      schemaVersion: 1,
      targetType: 'message',
      reference: {
        targetType: 'message',
        targetId: messageId,
        sourceVersion: evidence.sourceVersion,
      },
      capturedAt: new Date().toISOString(),
      category: input.category,
      safeMetadata: {
        message_version: evidence.sourceVersion,
        moderation_state: evidence.moderationState,
      },
    });
    try {
      return await this.safety.reportWithSnapshot(
        actor,
        {
          subject_account_id: input.subject_account_id,
          target_type: 'message',
          target_id: messageId,
          category: input.category,
          idempotency_key: input.idempotency_key,
        },
        snapshot,
      );
    } catch {
      throw notFound();
    }
  }
  async draft(actor: string, id: string, input: AiDraftRequest) {
    const c = await this.requireConversation(actor, id);
    try {
      const suggestion = aiSuggestionOutputSchema.parse(
        await this.ai.suggest({
          ...(input.context === undefined ? {} : { context: input.context }),
          mode: c.mode,
        }),
      );
      return await this.repo.createAiDraft({
        actorAccountId: actor,
        conversationId: id,
        body: suggestion.draft,
        provider: suggestion.provider,
        consent: input.consent,
      });
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      throw new ServiceUnavailableException({
        code: 'AI_UNAVAILABLE',
        message: 'Suggestion unavailable',
      });
    }
  }
  async getDraft(actor: string, draftId: string) {
    const conversation = await this.repo.getAiDraftConversation(actor, draftId);
    if (!conversation || !(await this.finalGate(actor, conversation))) throw notFound();
    const d = await this.repo.getAiDraft(actor, draftId);
    if (!d) throw notFound();
    return d;
  }
  async deleteDraft(actor: string, draftId: string) {
    const conversation = await this.repo.getAiDraftConversation(actor, draftId);
    if (!conversation || !(await this.finalGate(actor, conversation))) throw notFound();
    await this.repo.deleteAiDraft(actor, draftId);
    return { ok: true };
  }
  async subscribe(actor: string, id: string) {
    const c = await this.requireConversation(actor, id);
    return {
      conversation_id: c.id,
      transport: 'cursor_polling',
      wake: 'opaque_only',
      recovery:
        'Use the signed history cursor from PostgreSQL; this endpoint does not claim a live socket subscription.',
    };
  }

  private async requireConversation(actor: string, id: string) {
    const c = await this.repo.getConversation(actor, id);
    if (!c || !(await this.finalGate(actor, c))) throw notFound();
    return c;
  }
  private async finalGate(actor: string, c: MessagingConversation) {
    return this.allowed(
      actor,
      c.participant_account_id,
      c.mode,
      c.connection_id,
      c.connection_epoch,
    );
  }
  private async allowed(
    actor: string,
    subject: string,
    mode: ConnectionMode,
    connectionId: string,
    epoch: number,
  ) {
    const current = await this.connections.isCurrentAccepted({
      connectionId,
      acceptedEpoch: epoch,
      senderAccountId: actor,
      recipientAccountId: subject,
    });
    if (!current || current.mode !== mode) return false;
    const d = await this.gate.check({
      actorAccountId: actor,
      subjectAccountId: subject,
      capability: 'direct_message',
      mode,
      surface: 'chat',
      requireConnection: true,
      connectionId,
      acceptedEpoch: epoch,
    });
    return d.allowed;
  }
  private map(e: unknown): Error {
    const code = e instanceof Error ? e.message : '';
    if (code === 'INVALID_CURSOR')
      return new ConflictException({ code: 'VALIDATION_ERROR', message: 'Cursor is invalid' });
    if (code === 'IDEMPOTENCY_CONFLICT')
      return new ConflictException({ code, message: 'Idempotency key conflict' });
    if (
      code === 'OPENING_REFERENCE_INVALID' ||
      code === 'CONNECTION_NOT_CURRENT' ||
      code === 'MESSAGE_NOT_FOUND'
    )
      return notFound();
    return new ServiceUnavailableException({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Messaging service unavailable',
    });
  }
}
