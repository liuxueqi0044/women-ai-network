import { describe, expect, it, vi } from 'vitest';
import { JOB_NAMES } from '@wai/contracts';
import { processTranslationWakeup } from './wakeup.js';

describe('translation opaque wake-up', () => {
  it('passes only the validated task id to the durable runner', async () => {
    const runner = { runOnce: vi.fn().mockResolvedValue(true) };
    await expect(
      processTranslationWakeup(runner, {
        name: JOB_NAMES.translationProcess,
        data: { task_id: '11111111-1111-4111-8111-111111111111' },
      }),
    ).resolves.toBe('completed');
    expect(runner.runOnce).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    await expect(
      processTranslationWakeup(runner, {
        name: JOB_NAMES.translationProcess,
        data: { task_id: 'not-a-uuid' },
      }),
    ).rejects.toThrow();
  });
});
