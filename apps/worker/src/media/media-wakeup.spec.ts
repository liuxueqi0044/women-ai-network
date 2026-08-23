import { describe, expect, it } from 'vitest';
import { processMediaWakeup } from '../worker.module.js';

describe('MED-01 queue wake-up retry contract', () => {
  it('turns retryable scanner/provider state into a bounded BullMQ retry', async () => {
    await expect(
      processMediaWakeup({ runOnce: async () => 'retryable' }, 'worker-test'),
    ).rejects.toThrow('media_retryable');
  });

  it('acknowledges clean and idle wake-ups', async () => {
    await expect(processMediaWakeup({ runOnce: async () => 'clean' }, 'worker-test')).resolves.toBe(
      'clean',
    );
    await expect(processMediaWakeup({ runOnce: async () => 'idle' }, 'worker-test')).resolves.toBe(
      'idle',
    );
  });

  it('rejects invalid name/payload before claiming the durable job', async () => {
    let claims = 0;
    const runner = {
      runOnce: async () => {
        claims += 1;
        return 'clean' as const;
      },
    };
    await expect(
      processMediaWakeup(runner, 'worker-test', {
        name: 'other.job',
        data: { job_id: 'not-a-uuid', asset_id: 'not-a-uuid' },
      }),
    ).rejects.toThrow('media_invalid_job');
    await expect(
      processMediaWakeup(runner, 'worker-test', {
        name: 'media.process',
        data: { job_id: 'not-a-uuid', asset_id: 'not-a-uuid' },
      }),
    ).rejects.toThrow();
    expect(claims).toBe(0);
  });
});
