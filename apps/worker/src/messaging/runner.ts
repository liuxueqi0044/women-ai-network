import {
  messagingWakeupJobSchema,
  realtimeHintSchema,
  type MessagingHintDispatchPort,
  type MessagingOutboxRepositoryPort,
} from '@wai/contracts';

/** Durable wake dispatcher. BullMQ only carries opaque IDs; PostgreSQL claims
 * and final-gates the outbox row before an opaque hint is emitted. A row is
 * marked dispatched only after the adapter accepts that hint. */
export class MessagingWakeupRunner {
  constructor(
    private readonly repository: MessagingOutboxRepositoryPort,
    private readonly workerId: string,
    private readonly dispatcher: MessagingHintDispatchPort,
  ) {}
  async runOnce(limit = 25): Promise<number> {
    await this.repository.reapExpiredAiDrafts(100);
    await this.repository.releaseStaleOutbox(this.workerId);
    const rows = await this.repository.claimOutbox(limit, this.workerId);
    let completed = 0;
    for (const row of rows) {
      messagingWakeupJobSchema.parse({
        conversation_id: row.conversationId,
        message_id: row.messageId,
      });
      const authorization = await this.repository.authorizeOutbox(row.id, this.workerId);
      if (authorization.status === 'cancelled') {
        completed += 1;
        continue;
      }
      if (authorization.status === 'retry') continue;
      try {
        await this.dispatcher.emit(realtimeHintSchema.parse(authorization.hint));
        if ((await this.repository.completeOutbox(row.id, this.workerId)) === 'dispatched')
          completed += 1;
      } catch {
        await this.repository.failOutbox(row.id, this.workerId, 'HINT_DISPATCH_FAILED');
      }
    }
    return completed;
  }
  close(): Promise<void> {
    return this.dispatcher.close?.() ?? Promise.resolve();
  }
}

/** Realtime is intentionally disabled until a channel adapter is configured.
 * Pending rows remain retryable and are reconciled by the worker sweep. */
export const unavailableMessagingHintDispatcher: MessagingHintDispatchPort = {
  async emit() {
    throw new Error('MESSAGING_HINT_CHANNEL_UNAVAILABLE');
  },
};
