import { describe, expect, it, vi } from 'vitest';
import type {
  InteractionGatePort,
  LetterRepositoryPort,
  PrivateDeliveryRepositoryPort,
} from '@wai/contracts';
import { PrivateDeliveryService } from './private-delivery.service.js';

const sender = '00000000-0000-4000-8000-000000000001';
const recipient = '00000000-0000-4000-8000-000000000002';
const letter = '00000000-0000-4000-8000-000000000003';
const delivery = '00000000-0000-4000-8000-000000000005';

function limiter() {
  return { consume: vi.fn().mockResolvedValue({ allowed: true }) };
}
function result(state: 'queued' | 'delivered' = 'queued') {
  return {
    deliveryId: delivery,
    senderAccountId: sender,
    recipientAccountId: recipient,
    state,
    revision: 1,
    createdAt: new Date().toISOString(),
  };
}

describe('PrivateDeliveryService', () => {
  it('replays before rate limits and policy, while re-waking only queued delivery', async () => {
    const repo = {
      replayCreate: vi.fn().mockResolvedValue(result()),
      getDeliveryContext: vi.fn().mockResolvedValue({
        deliveryId: delivery,
        senderAccountId: sender,
        recipientAccountId: recipient,
        connectionId: '00000000-0000-4000-8000-000000000006',
        connectionEpoch: 1,
        mode: 'friends',
        state: 'queued',
      }),
      shouldWake: vi.fn().mockResolvedValue(true),
      getForRecipient: vi.fn(),
      getForSender: vi.fn(),
      list: vi.fn(),
      markRead: vi.fn(),
      hide: vi.fn(),
    } as unknown as PrivateDeliveryRepositoryPort;
    const gate = {
      check: vi.fn().mockResolvedValue({ allowed: true }),
    } as unknown as InteractionGatePort;
    const service = new PrivateDeliveryService(
      repo,
      {} as LetterRepositoryPort,
      { isCurrentAccepted: vi.fn().mockResolvedValue({ mode: 'friends' }) } as never,
      gate,
      limiter(),
      { enqueue: vi.fn().mockResolvedValue(undefined) },
    );
    await expect(
      service.create(
        sender,
        {
          recipient_id: recipient,
          letter_id: letter,
          revision: 1,
          purpose: 'private_letter_delivery',
          consent: { explicit: true },
        },
        'idempotency-key-1234',
      ),
    ).resolves.toMatchObject({ deliveryId: delivery });
    expect(gate.check).toHaveBeenCalledOnce();
  });

  it('requires private owner revision and server-derived accepted connection', async () => {
    const repo = {
      replayCreate: vi.fn().mockResolvedValue(null),
      createQueued: vi.fn(),
      shouldWake: vi.fn(),
      getForRecipient: vi.fn(),
      getForSender: vi.fn(),
      list: vi.fn(),
      markRead: vi.fn(),
      hide: vi.fn(),
    } as unknown as PrivateDeliveryRepositoryPort;
    const letters = {
      readOwnedRevision: vi.fn().mockResolvedValue(null),
    } as unknown as LetterRepositoryPort;
    const connections = { currentAccepted: vi.fn(), isCurrentAccepted: vi.fn() };
    const service = new PrivateDeliveryService(
      repo,
      letters,
      connections as never,
      { check: vi.fn() },
      limiter(),
      { enqueue: vi.fn() },
    );
    await expect(
      service.create(
        sender,
        {
          recipient_id: recipient,
          letter_id: letter,
          revision: 1,
          purpose: 'private_letter_delivery',
          consent: { explicit: true },
        },
        'idempotency-key-1234',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(connections.currentAccepted).not.toHaveBeenCalled();
    expect(repo.createQueued).not.toHaveBeenCalled();
  });

  it('does not disclose or wake a frozen replay after block/policy denial', async () => {
    const repo = {
      replayCreate: vi.fn().mockResolvedValue(result()),
      getDeliveryContext: vi.fn().mockResolvedValue({
        deliveryId: delivery,
        senderAccountId: sender,
        recipientAccountId: recipient,
        connectionId: '00000000-0000-4000-8000-000000000006',
        connectionEpoch: 1,
        mode: 'friends',
        state: 'queued',
      }),
      shouldWake: vi.fn().mockResolvedValue(true),
    } as unknown as PrivateDeliveryRepositoryPort;
    const enqueue = vi.fn();
    const service = new PrivateDeliveryService(
      repo,
      {} as LetterRepositoryPort,
      { isCurrentAccepted: vi.fn().mockResolvedValue({ mode: 'friends' }) } as never,
      { check: vi.fn().mockResolvedValue({ allowed: false, reason: 'ACTIVE_BLOCK' }) },
      limiter(),
      { enqueue },
    );
    await expect(
      service.create(
        sender,
        {
          recipient_id: recipient,
          letter_id: letter,
          revision: 1,
          purpose: 'private_letter_delivery',
          consent: { explicit: true },
        },
        'idempotency-key-1234',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(repo.shouldWake).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('allows recipient hide after the connection is gone without reopening the item', async () => {
    const item = {
      sender_id: sender,
      recipient_id: recipient,
      connection_id: '00000000-0000-4000-8000-000000000006',
      connection_epoch: 1,
      mode: 'friends',
    };
    const repo = {
      getForRecipient: vi.fn().mockResolvedValue(item),
      hide: vi.fn().mockResolvedValue(undefined),
    } as unknown as PrivateDeliveryRepositoryPort;
    const connections = {
      currentAccepted: vi.fn(),
      isCurrentAccepted: vi.fn().mockResolvedValue(null),
    };
    const gate = { check: vi.fn() } as unknown as InteractionGatePort;
    const service = new PrivateDeliveryService(
      repo,
      {} as LetterRepositoryPort,
      connections as never,
      gate,
      limiter(),
      { enqueue: vi.fn() },
    );
    await expect(service.hide(recipient, delivery)).resolves.toEqual({ ok: true });
    expect(repo.hide).toHaveBeenCalledWith(recipient, delivery);
    expect(gate.check).not.toHaveBeenCalled();
  });

  it('final-gates mark-read and does not mutate after connection loss', async () => {
    const item = {
      sender_id: sender,
      recipient_id: recipient,
      connection_id: '00000000-0000-4000-8000-000000000006',
      connection_epoch: 1,
      mode: 'friends',
    };
    const repo = {
      getForRecipient: vi.fn().mockResolvedValue(item),
      markRead: vi.fn(),
    } as unknown as PrivateDeliveryRepositoryPort;
    const service = new PrivateDeliveryService(
      repo,
      {} as LetterRepositoryPort,
      { isCurrentAccepted: vi.fn().mockResolvedValue(null) } as never,
      { check: vi.fn() },
      limiter(),
      { enqueue: vi.fn() },
    );
    await expect(service.markRead(recipient, delivery)).rejects.toMatchObject({ status: 404 });
    expect(repo.markRead).not.toHaveBeenCalled();
  });
});
