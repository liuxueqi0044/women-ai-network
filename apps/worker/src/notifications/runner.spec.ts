import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDeliveryRunner,
  isQuietHour,
  quietDelayMs,
  type NotificationLease,
  type NotificationWorkerRepository,
} from './runner.js';

const lease = {
  intentId: '00000000-0000-4000-8000-000000000001',
  leaseToken: '00000000-0000-4000-8000-000000000002',
  fence: 2,
  recipientAccountId: '00000000-0000-4000-8000-000000000003',
  channel: 'email' as const,
  resourceKind: 'letter' as const,
  resourceId: 'resource:1',
  eventKey: 'letter.received' as const,
  category: 'letters',
  timeZone: 'America/New_York',
  uiLocale: 'en',
  quietStartMinute: 0,
  quietEndMinute: 0,
  digestCadence: 'immediate' as const,
  nextAttemptAt: null,
  digestDueAt: null,
  digestCadenceBucket: null,
  criticalSafetyException: false,
};
function repo(): NotificationWorkerRepository {
  return {
    releaseExpiredLeases: vi.fn(async () => undefined),
    claimDue: vi.fn(async (_limit, _worker, intentId) =>
      intentId === lease.intentId ? [lease] : [],
    ),
    complete: vi.fn(async () => 'sent' as const),
    retry: vi.fn(async () => 'retrying' as const),
    retain: vi.fn(async () => 'retained' as const),
    suppress: vi.fn(async () => 'suppressed' as const),
  };
}
describe('notification worker fencing and privacy', () => {
  it('binds a wake job to the exact intent and never puts resource data in provider payload', async () => {
    const repository = repo();
    const provider = {
      channel: 'email' as const,
      send: vi.fn(
        async (payload: {
          intent_id: string;
          idempotency_key: string;
          channel: 'email';
          subject: string;
          body: string;
        }) => {
          expect(payload).toEqual({
            intent_id: lease.intentId,
            idempotency_key: `notification-intent:${lease.intentId}`,
            channel: 'email',
            subject: 'You received a letter',
            body: 'You received a letter',
          });
          return { accepted: true };
        },
      ),
    };
    const runner = new NotificationDeliveryRunner(
      repository,
      { check: vi.fn(async () => ({ allowed: true })) },
      new Map([['email', provider]]),
      3,
    );
    await runner.process(
      { name: 'notifications.wakeup', data: { intent_id: lease.intentId } },
      'worker-1',
    );
    expect(repository.claimDue).toHaveBeenCalledWith(1, 'worker-1', lease.intentId);
    expect(provider.send).toHaveBeenCalledOnce();
  });
  it('keeps quiet-hour deferral retryable without provider attempt', async () => {
    const repository = repo();
    vi.mocked(repository.claimDue).mockResolvedValue([
      { ...lease, timeZone: 'UTC', quietStartMinute: 0, quietEndMinute: 1439 },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const runner = new NotificationDeliveryRunner(
      repository,
      { check: vi.fn(async () => ({ allowed: true })) },
      new Map(),
      1,
    );
    try {
      const result = await runner.process(
        { name: 'notifications.wakeup', data: { intent_id: lease.intentId } },
        'worker-1',
      );
      expect(result).toBe('retrying');
      expect(repository.retry).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'QUIET_HOURS' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses real IANA transitions for quiet-hour due time and never treats equal bounds as quiet', () => {
    expect(isQuietHour(new Date('2026-03-08T06:30:00.000Z'), 'America/New_York', 60, 240)).toBe(
      true,
    );
    expect(quietDelayMs(new Date('2026-03-08T06:30:00.000Z'), 'America/New_York', 60, 240)).toBe(
      90 * 60_000,
    );
    expect(quietDelayMs(new Date('2026-04-05T15:00:00.000Z'), 'Australia/Lord_Howe', 0, 1)).toBe(0);
    expect(isQuietHour(new Date(), 'UTC', 0, 0)).toBe(false);
  });
  it('defers digest cadence without provider send', async () => {
    const repository = repo();
    const digestLease = { ...lease, digestCadence: 'daily' as const };
    vi.mocked(repository.claimDue).mockResolvedValue([digestLease]);
    const runner = new NotificationDeliveryRunner(
      repository,
      { check: vi.fn(async () => ({ allowed: true })) },
      new Map(),
      1,
    );
    expect(
      await runner.process(
        { name: 'notifications.wakeup', data: { intent_id: lease.intentId } },
        'worker-1',
      ),
    ).toBe('retrying');
    expect(repository.retry).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'DIGEST_CADENCE' }),
    );
  });
  it('sends exactly once after the persisted digest due bucket', async () => {
    const repository = repo();
    let current: NotificationLease = {
      ...lease,
      digestCadence: 'daily' as const,
      nextAttemptAt: null as string | null,
      digestDueAt: null as string | null,
    };
    vi.mocked(repository.claimDue).mockImplementation(async () => [current]);
    vi.mocked(repository.retry).mockImplementation(async (input) => {
      if (input.reason === 'DIGEST_CADENCE')
        current = {
          ...current,
          nextAttemptAt: new Date().toISOString(),
          digestDueAt: new Date().toISOString(),
          digestCadenceBucket: 'daily',
        };
      return 'retrying';
    });
    const provider = { channel: 'email' as const, send: vi.fn(async () => ({ accepted: true })) };
    const runner = new NotificationDeliveryRunner(
      repository,
      { check: vi.fn(async () => ({ allowed: true })) },
      new Map([['email', provider]]),
      3,
    );
    expect(
      await runner.process(
        { name: 'notifications.wakeup', data: { intent_id: lease.intentId } },
        'w',
      ),
    ).toBe('retrying');
    expect(
      await runner.process(
        { name: 'notifications.wakeup', data: { intent_id: lease.intentId } },
        'w',
      ),
    ).toBe('sent');
    expect(provider.send).toHaveBeenCalledOnce();
  });
  it('uses the registry-derived critical exception for digest bypass', async () => {
    const repository = repo();
    vi.mocked(repository.claimDue).mockResolvedValue([
      {
        ...lease,
        eventKey: 'safety.action_required',
        category: 'critical-safety',
        digestCadence: 'weekly',
        criticalSafetyException: true,
      },
    ]);
    const provider = { channel: 'email' as const, send: vi.fn(async () => ({ accepted: true })) };
    const runner = new NotificationDeliveryRunner(
      repository,
      { check: vi.fn(async () => ({ allowed: true })) },
      new Map([['email', provider]]),
    );
    expect(
      await runner.process(
        { name: 'notifications.wakeup', data: { intent_id: lease.intentId } },
        'w',
      ),
    ).toBe('sent');
    expect(provider.send).toHaveBeenCalledOnce();
    expect(repository.retry).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'DIGEST_CADENCE' }),
    );
  });
  it('retains an unconfigured provider without consuming an attempt', async () => {
    const repository = repo();
    const runner = new NotificationDeliveryRunner(
      repository,
      { check: vi.fn(async () => ({ allowed: true })) },
      new Map(),
    );
    expect(
      await runner.process(
        { name: 'notifications.wakeup', data: { intent_id: lease.intentId } },
        'w',
      ),
    ).toBe('retrying');
    expect(repository.retain).toHaveBeenCalledWith({
      intentId: lease.intentId,
      leaseToken: lease.leaseToken,
      fence: lease.fence,
    });
    expect(repository.retry).not.toHaveBeenCalled();
  });
});
