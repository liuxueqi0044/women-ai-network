import { describe, expect, it, vi } from 'vitest';
import { TranslationWakeReconciler } from './reconciler.js';

describe('translation retry wake reconciler', () => {
  it('starts one timer and closes it without leaving a wake loop', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const repository = {
      reapExpiredLeases: vi.fn().mockResolvedValue([]),
      listDueWakeups: vi.fn().mockResolvedValue([]),
      markWakeupEnqueued: vi.fn(),
    };
    const reconciler = new TranslationWakeReconciler(repository, { add: vi.fn() }, 60_000);

    reconciler.start();
    reconciler.start();
    await reconciler.close();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('reaps expired leases before scanning durable wake intents', async () => {
    const repository = {
      reapExpiredLeases: vi.fn().mockResolvedValue([
        {
          taskId: '00000000-0000-4000-8000-000000000001',
          attempt: 1,
          nextRetryAt: new Date('2026-08-19T00:00:00.000Z'),
        },
      ]),
      listDueWakeups: vi.fn().mockResolvedValue([]),
      markWakeupEnqueued: vi.fn(),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const reconciler = new TranslationWakeReconciler(repository, queue);

    await (reconciler as unknown as { reconcile(): Promise<void> }).reconcile();

    expect(repository.reapExpiredLeases).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, now: expect.any(Date) }),
    );
  });

  it('enqueues only opaque deterministic task wakeups and marks them after add', async () => {
    const repository = {
      listDueWakeups: vi.fn().mockResolvedValue([
        {
          taskId: '11111111-1111-4111-8111-111111111111',
          attempt: 2,
          nextRetryAt: new Date('2026-08-19T00:00:00.000Z'),
        },
      ]),
      reapExpiredLeases: vi.fn().mockResolvedValue([]),
      markWakeupEnqueued: vi.fn().mockResolvedValue(true),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const reconciler = new TranslationWakeReconciler(repository, queue);

    await (reconciler as unknown as { reconcile(): Promise<void> }).reconcile();

    expect(queue.add).toHaveBeenCalledWith(
      'translation.process',
      { task_id: '11111111-1111-4111-8111-111111111111' },
      expect.objectContaining({ jobId: '11111111-1111-4111-8111-111111111111:wake:2' }),
    );
    expect(repository.markWakeupEnqueued).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: '11111111-1111-4111-8111-111111111111',
        attempt: 2,
      }),
    );
  });

  it('leaves the intent unmarked when queue delivery fails', async () => {
    const repository = {
      listDueWakeups: vi.fn().mockResolvedValue([
        {
          taskId: '22222222-2222-4222-8222-222222222222',
          attempt: 1,
          nextRetryAt: new Date(),
        },
      ]),
      reapExpiredLeases: vi.fn().mockResolvedValue([]),
      markWakeupEnqueued: vi.fn(),
    };
    const queue = { add: vi.fn().mockRejectedValue(new Error('valkey unavailable')) };
    const reconciler = new TranslationWakeReconciler(repository, queue);

    await expect(
      (reconciler as unknown as { reconcile(): Promise<void> }).reconcile(),
    ).rejects.toThrow('valkey unavailable');
    expect(repository.markWakeupEnqueued).not.toHaveBeenCalled();
  });
});
