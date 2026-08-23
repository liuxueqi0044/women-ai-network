import { describe, expect, it, vi } from 'vitest';
import type { InteractionGatePort, PrivateDeliveryRepositoryPort } from '@wai/contracts';
import { DurablePrivateDeliveryRunner } from './runner.js';

const lease = {
  deliveryId: '00000000-0000-4000-8000-000000000001',
  leaseToken: 'lease',
  senderAccountId: '00000000-0000-4000-8000-000000000002',
  recipientAccountId: '00000000-0000-4000-8000-000000000003',
  connectionId: '00000000-0000-4000-8000-000000000004',
  connectionEpoch: 1,
  mode: 'friends' as const,
};

function repository() {
  return {
    claim: vi.fn().mockResolvedValue(lease),
    cancel: vi.fn().mockResolvedValue('cancelled'),
    complete: vi.fn().mockResolvedValue('delivered'),
    dispatchOutbox: vi.fn().mockResolvedValue('dispatched'),
    retry: vi.fn().mockResolvedValue('retrying'),
    getDeliveryContext: vi.fn().mockResolvedValue(null),
  } as unknown as PrivateDeliveryRepositoryPort;
}

describe('PVL worker runner', () => {
  it('rejects malformed or wrong-name wakeups before claiming PostgreSQL', async () => {
    const repo = repository();
    const gate = { check: vi.fn() } as unknown as InteractionGatePort;
    const runner = new DurablePrivateDeliveryRunner(repo, gate);
    await expect(
      runner.process('worker', { name: 'wrong', data: { delivery_id: lease.deliveryId } }),
    ).rejects.toThrow('private_delivery_invalid_job');
    await expect(
      runner.process('worker', { name: 'private-delivery.wakeup', data: { delivery_id: 'bad' } }),
    ).rejects.toThrow();
    expect(repo.claim).not.toHaveBeenCalled();
  });

  it('claims the opaque delivery id and cancels when final policy denies', async () => {
    const repo = repository();
    const gate: InteractionGatePort = {
      check: vi.fn().mockResolvedValue({ allowed: false, reason: 'ACTIVE_BLOCK' }),
    };
    const result = await new DurablePrivateDeliveryRunner(repo, gate).process('worker', {
      name: 'private-delivery.wakeup',
      data: { delivery_id: lease.deliveryId },
    });
    expect(result).toBe('cancelled');
    expect(repo.claim).toHaveBeenCalledWith({
      workerId: 'worker',
      leaseMs: 30_000,
      deliveryId: lease.deliveryId,
    });
    expect(repo.cancel).toHaveBeenCalledWith({
      deliveryId: lease.deliveryId,
      leaseToken: lease.leaseToken,
      reason: 'ACTIVE_BLOCK',
    });
  });

  it('propagates a database outbox cancellation instead of reporting delivered', async () => {
    const repo = repository();
    repo.dispatchOutbox = vi.fn().mockResolvedValue('cancelled');
    const gate: InteractionGatePort = { check: vi.fn().mockResolvedValue({ allowed: true }) };
    await expect(
      new DurablePrivateDeliveryRunner(repo, gate).process('worker', {
        name: 'private-delivery.wakeup',
        data: { delivery_id: lease.deliveryId },
      }),
    ).resolves.toBe('cancelled');
  });

  it('retries policy-unavailable rather than permanently cancelling the delivery', async () => {
    const repo = repository();
    const gate: InteractionGatePort = {
      check: vi.fn().mockResolvedValue({ allowed: false, reason: 'POLICY_UNAVAILABLE' }),
    };
    await expect(
      new DurablePrivateDeliveryRunner(repo, gate).process('worker', {
        name: 'private-delivery.wakeup',
        data: { delivery_id: lease.deliveryId },
      }),
    ).resolves.toBe('retrying');
    expect(repo.cancel).not.toHaveBeenCalled();
  });

  it('keeps a delivered notification pending when notification policy is unavailable', async () => {
    const repo = repository();
    repo.dispatchOutbox = vi.fn().mockResolvedValue('retrying');
    const gate: InteractionGatePort = {
      check: vi
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false, reason: 'POLICY_UNAVAILABLE' }),
    };
    await expect(
      new DurablePrivateDeliveryRunner(repo, gate).process('worker', {
        name: 'private-delivery.wakeup',
        data: { delivery_id: lease.deliveryId },
      }),
    ).resolves.toBe('retrying');
    expect(repo.dispatchOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: false, retryable: true }),
    );
  });
});
