import {
  formatGlobalizationMessage,
  notificationMessageKey,
  notificationWakeJobSchema,
  type NotificationProviderPort,
  type NotificationResourceGatePort,
} from '@wai/contracts';

export type NotificationLease = {
  intentId: string;
  leaseToken: string;
  fence: number;
  recipientAccountId: string;
  channel: 'email' | 'push';
  resourceKind:
    | 'letter'
    | 'conversation'
    | 'connection'
    | 'introduction'
    | 'event'
    | 'circle'
    | 'safety_action';
  resourceId: string;
  eventKey:
    | 'letter.received'
    | 'message.received'
    | 'connection.created'
    | 'introduction.available'
    | 'event.reminder'
    | 'circle.invitation'
    | 'safety.action_required';
  category: string;
  timeZone: string;
  uiLocale: string;
  quietStartMinute: number;
  quietEndMinute: number;
  digestCadence: 'immediate' | 'daily' | 'weekly';
  nextAttemptAt: string | null;
  digestDueAt: string | null;
  digestCadenceBucket: 'daily' | 'weekly' | null;
  criticalSafetyException: boolean;
};
export interface NotificationWorkerRepository {
  releaseExpiredLeases(workerId: string): Promise<void>;
  claimDue(limit: number, workerId: string, intentId: string): Promise<NotificationLease[]>;
  complete(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
    providerId?: string;
  }): Promise<'sent' | 'stale'>;
  retry(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
    reason: string;
    retryAfterMs: number;
    digestCadence?: 'daily' | 'weekly';
    maxAttempts?: number;
  }): Promise<'retrying' | 'failed' | 'stale'>;
  retain(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
  }): Promise<'retained' | 'stale'>;
  suppress(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
  }): Promise<'suppressed' | 'stale'>;
}
export function localMinute(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return (
    Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 +
    Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  );
}
export function isQuietHour(date: Date, timeZone: string, start: number, end: number): boolean {
  if (start === end) return false;
  const minute = localMinute(date, timeZone);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
/** Find the next real instant outside quiet hours by walking UTC minutes. This
 * deliberately uses the current IANA rules through Intl, so DST gaps,
 * overlaps, and half-hour transitions cannot create an invalid local instant.
 */
export function quietDelayMs(date: Date, timeZone: string, start: number, end: number): number {
  if (!isQuietHour(date, timeZone, start, end)) return 0;
  for (let minute = 1; minute <= 7 * 24 * 60; minute++) {
    const candidate = new Date(date.getTime() + minute * 60_000);
    if (!isQuietHour(candidate, timeZone, start, end)) return minute * 60_000;
  }
  return 7 * 24 * 60 * 60_000;
}
function cadenceDelayMs(date: Date, cadence: NotificationLease['digestCadence']): number {
  if (cadence === 'immediate') return 0;
  return (cadence === 'daily' ? 24 : 7 * 24) * 60 * 60_000;
}
export class NotificationDeliveryRunner {
  constructor(
    private readonly repository: NotificationWorkerRepository,
    private readonly gate: NotificationResourceGatePort,
    private readonly providers: ReadonlyMap<'email' | 'push', NotificationProviderPort>,
    private readonly maxAttempts = 5,
  ) {}
  async process(
    job: { name: string; data: unknown },
    workerId: string,
  ): Promise<'sent' | 'retrying' | 'failed' | 'suppressed' | 'idle'> {
    const wake = notificationWakeJobSchema.parse(job.data);
    if (job.name !== 'notifications.wakeup') throw new Error('notification_invalid_job');
    await this.repository.releaseExpiredLeases(workerId);
    const rows = await this.repository.claimDue(1, workerId, wake.intent_id);
    const lease = rows[0];
    if (!lease) return 'idle';
    const gate = await this.gate.check({
      actorAccountId: lease.recipientAccountId,
      recipientAccountId: lease.recipientAccountId,
      resourceKind: lease.resourceKind,
      resourceId: lease.resourceId,
      eventKey: lease.eventKey,
    });
    if (!gate.allowed) {
      if (gate.retryable) {
        const result = await this.repository.retry({
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          fence: lease.fence,
          reason: 'GATE_UNAVAILABLE',
          retryAfterMs: 60_000,
          maxAttempts: this.maxAttempts,
        });
        return result === 'failed' ? 'failed' : 'retrying';
      }
      await this.repository.suppress({
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
      });
      return 'suppressed';
    }
    if (
      !lease.criticalSafetyException &&
      isQuietHour(new Date(), lease.timeZone, lease.quietStartMinute, lease.quietEndMinute)
    ) {
      await this.repository.retry({
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
        reason: 'QUIET_HOURS',
        retryAfterMs: quietDelayMs(
          new Date(),
          lease.timeZone,
          lease.quietStartMinute,
          lease.quietEndMinute,
        ),
        maxAttempts: this.maxAttempts,
      });
      return 'retrying';
    }
    const digestDelay = cadenceDelayMs(new Date(), lease.digestCadence);
    if (
      !lease.criticalSafetyException &&
      digestDelay > 0 &&
      (lease.digestDueAt === null || lease.digestCadenceBucket !== lease.digestCadence)
    ) {
      await this.repository.retry({
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
        reason: 'DIGEST_CADENCE',
        retryAfterMs: digestDelay,
        ...(lease.digestCadence === 'immediate' ? {} : { digestCadence: lease.digestCadence }),
        maxAttempts: this.maxAttempts,
      });
      return 'retrying';
    }
    const provider = this.providers.get(lease.channel);
    if (!provider) {
      const result = await this.repository.retain({
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
      });
      return result === 'stale' ? 'idle' : 'retrying';
    }
    try {
      const result = await provider.send({
        intent_id: lease.intentId,
        idempotency_key: `notification-intent:${lease.intentId}`,
        channel: lease.channel,
        subject: formatGlobalizationMessage(lease.uiLocale, notificationMessageKey[lease.eventKey]),
        body: formatGlobalizationMessage(lease.uiLocale, notificationMessageKey[lease.eventKey]),
      });
      if (!result.accepted) throw new Error('PROVIDER_REJECTED');
      const completed = await this.repository.complete({
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
        ...(result.provider_id ? { providerId: result.provider_id } : {}),
      });
      return completed === 'sent' ? 'sent' : 'idle';
    } catch {
      const result = await this.repository.retry({
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
        reason: 'PROVIDER_FAILURE',
        retryAfterMs: 60_000,
        maxAttempts: this.maxAttempts,
      });
      return result === 'failed' ? 'failed' : 'retrying';
    }
  }
}
export const unavailableNotificationProviders = new Map<
  'email' | 'push',
  NotificationProviderPort
>();
