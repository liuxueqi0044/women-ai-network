import {
  privateDeliveryWakeupSchema,
  type ConnectionMode,
  type InteractionGatePort,
  type PrivateDeliveryRepositoryPort,
} from '@wai/contracts';

export interface PrivateDeliveryWorkerRunner {
  process(
    workerId: string,
    job: { name: string; data: unknown },
  ): Promise<'delivered' | 'cancelled' | 'retrying' | 'failed' | 'idle'>;
}

export class DurablePrivateDeliveryRunner implements PrivateDeliveryWorkerRunner {
  constructor(
    private readonly repository: PrivateDeliveryRepositoryPort,
    private readonly gate: InteractionGatePort,
  ) {}

  async process(
    workerId: string,
    job: { name: string; data: unknown },
  ): Promise<'delivered' | 'cancelled' | 'retrying' | 'failed' | 'idle'> {
    if (job.name !== 'private-delivery.wakeup') throw new Error('private_delivery_invalid_job');
    const parsed = privateDeliveryWakeupSchema.parse(job.data);
    const lease = await this.repository.claim({
      workerId,
      leaseMs: 30_000,
      deliveryId: parsed.delivery_id,
    });
    if (!lease || lease.deliveryId !== parsed.delivery_id) {
      const context = await this.repository.getDeliveryContext?.(parsed.delivery_id);
      if (!context || context.state !== 'delivered') return 'idle';
      return this.processOutbox(context);
    }
    const decision = await this.gate.check({
      actorAccountId: lease.senderAccountId,
      subjectAccountId: lease.recipientAccountId,
      capability: 'direct_message',
      mode: lease.mode,
      surface: 'chat',
      requireConnection: true,
      connectionId: lease.connectionId,
      acceptedEpoch: lease.connectionEpoch,
    });
    if (!decision.allowed) {
      if (decision.reason === 'POLICY_UNAVAILABLE') {
        const retry = await this.repository.retry({
          deliveryId: lease.deliveryId,
          leaseToken: lease.leaseToken,
          reason: decision.reason,
          retryAfterMs: 1000,
        });
        return retry === 'stale' ? 'idle' : retry;
      }
      const result = await this.repository.cancel({
        deliveryId: lease.deliveryId,
        leaseToken: lease.leaseToken,
        reason: decision.reason,
      });
      return result === 'stale' ? 'idle' : 'cancelled';
    }
    const result = await this.repository.complete({
      deliveryId: lease.deliveryId,
      leaseToken: lease.leaseToken,
    });
    if (result === 'delivered') {
      const dispatchDecision = await this.gate.check({
        actorAccountId: lease.senderAccountId,
        subjectAccountId: lease.recipientAccountId,
        capability: 'direct_message',
        mode: lease.mode,
        surface: 'notification',
        requireConnection: true,
        connectionId: lease.connectionId,
        acceptedEpoch: lease.connectionEpoch,
      });
      const outbox = await this.repository.dispatchOutbox({
        deliveryId: lease.deliveryId,
        recipientAccountId: lease.recipientAccountId,
        allowed: dispatchDecision.allowed,
        ...(dispatchDecision.allowed
          ? {}
          : { retryable: dispatchDecision.reason === 'POLICY_UNAVAILABLE' }),
      });
      if (outbox === 'cancelled') return 'cancelled';
      if (outbox === 'retrying') return 'retrying';
      if (outbox === 'stale') return 'idle';
    }
    return result === 'stale' ? 'idle' : result;
  }

  private async processOutbox(context: {
    deliveryId: string;
    senderAccountId: string;
    recipientAccountId: string;
    connectionId: string;
    connectionEpoch: number;
    mode: ConnectionMode;
  }): Promise<'delivered' | 'cancelled' | 'retrying' | 'failed' | 'idle'> {
    const decision = await this.gate.check({
      actorAccountId: context.senderAccountId,
      subjectAccountId: context.recipientAccountId,
      capability: 'direct_message',
      mode: context.mode,
      surface: 'notification',
      requireConnection: true,
      connectionId: context.connectionId,
      acceptedEpoch: context.connectionEpoch,
    });
    const outbox = await this.repository.dispatchOutbox({
      deliveryId: context.deliveryId,
      recipientAccountId: context.recipientAccountId,
      allowed: decision.allowed,
      ...(decision.allowed ? {} : { retryable: decision.reason === 'POLICY_UNAVAILABLE' }),
    });
    if (outbox === 'dispatched') return 'delivered';
    if (outbox === 'cancelled') return 'cancelled';
    if (outbox === 'retrying') return 'retrying';
    return 'idle';
  }
}
