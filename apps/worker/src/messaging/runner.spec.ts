import { describe, expect, it, vi } from 'vitest';
import type { MessagingHintDispatchPort, MessagingOutboxRepositoryPort } from '@wai/contracts';
import { MessagingWakeupRunner } from './runner.js';

function repository(overrides: Partial<MessagingOutboxRepositoryPort> = {}) {
  const base: MessagingOutboxRepositoryPort = {
    claimOutbox: vi.fn().mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: '00000000-0000-4000-8000-000000000002',
        messageId: '00000000-0000-4000-8000-000000000003',
        recipientId: '00000000-0000-4000-8000-000000000004',
      },
    ]),
    authorizeOutbox: vi.fn().mockResolvedValue({
      status: 'authorized',
      hint: {
        conversation_id: '00000000-0000-4000-8000-000000000002',
        message_id: '00000000-0000-4000-8000-000000000003',
        event: 'message.wake',
      },
    }),
    completeOutbox: vi.fn().mockResolvedValue('dispatched'),
    failOutbox: vi.fn().mockResolvedValue('retry'),
    releaseStaleOutbox: vi.fn().mockResolvedValue(0),
    reapExpiredAiDrafts: vi.fn().mockResolvedValue(0),
  };
  return { ...base, ...overrides };
}

describe('MessagingWakeupRunner', () => {
  it('final-gates, emits only opaque IDs, then fences completion to the lease', async () => {
    const repo = repository();
    const emit = vi.fn<MessagingHintDispatchPort['emit']>().mockResolvedValue();
    const runner = new MessagingWakeupRunner(repo, 'worker-a', { emit });

    await expect(runner.runOnce()).resolves.toBe(1);
    expect(emit).toHaveBeenCalledWith({
      conversation_id: '00000000-0000-4000-8000-000000000002',
      message_id: '00000000-0000-4000-8000-000000000003',
      event: 'message.wake',
    });
    expect(repo.completeOutbox).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'worker-a',
    );
    expect(emit.mock.calls[0]?.[0]).not.toHaveProperty('body');
  });

  it('releases for retry when channel emission fails and never marks dispatched', async () => {
    const repo = repository();
    const emit = vi.fn<MessagingHintDispatchPort['emit']>().mockRejectedValue(new Error('offline'));
    const runner = new MessagingWakeupRunner(repo, 'worker-a', { emit });

    await expect(runner.runOnce()).resolves.toBe(0);
    expect(repo.failOutbox).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'worker-a',
      'HINT_DISPATCH_FAILED',
    );
    expect(repo.completeOutbox).not.toHaveBeenCalled();
  });

  it('does not overwrite a stale lease completion and closes the adapter', async () => {
    const repo = repository({ completeOutbox: vi.fn().mockResolvedValue('retry') });
    const close = vi.fn<NonNullable<MessagingHintDispatchPort['close']>>().mockResolvedValue();
    const runner = new MessagingWakeupRunner(repo, 'worker-a', {
      emit: vi.fn<MessagingHintDispatchPort['emit']>().mockResolvedValue(),
      close,
    });

    await expect(runner.runOnce()).resolves.toBe(0);
    await runner.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
