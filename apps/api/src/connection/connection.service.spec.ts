import { describe, expect, it, vi } from 'vitest';
import { ConnectionService } from './connection.service.js';

describe('CON-01 connection service', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000003',
    requesterAccountId: '00000000-0000-4000-8000-000000000001',
    recipientAccountId: '00000000-0000-4000-8000-000000000002',
    mode: 'friends' as const,
    state: 'accepted' as const,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  function setup() {
    const repository = {
      replayCreateRequest: vi.fn().mockResolvedValue(null),
      createRequest: vi.fn().mockResolvedValue(row),
      replayTransition: vi.fn().mockResolvedValue(null),
      getForActor: vi.fn().mockResolvedValue(row),
      listForActor: vi.fn().mockResolvedValue({ rows: [row], nextCursor: null }),
      transition: vi.fn().mockResolvedValue(row),
    };
    const gate = { check: vi.fn().mockResolvedValue({ allowed: true }) };
    const limiter = { consume: vi.fn().mockResolvedValue({ allowed: true }) };
    return {
      service: new ConnectionService(repository, gate, limiter),
      repository,
      gate,
      limiter,
    };
  }

  it('has an explicit service implementation surface and preserves public DTOs', async () => {
    const { service } = setup();
    expect(ConnectionService).toBeDefined();
    await expect(service.get(row.requesterAccountId, row.id)).resolves.toMatchObject({
      id: row.id,
      state: 'accepted',
    });
  });

  it('hides IDOR and gate denial as the same not-found response', async () => {
    const hidden = setup();
    hidden.repository.getForActor.mockResolvedValue(null);
    await expect(
      hidden.service.get('00000000-0000-4000-8000-000000000009', row.id),
    ).rejects.toMatchObject({ status: 404 });
    const denied = setup();
    denied.gate.check.mockResolvedValue({ allowed: false, reason: 'ACTIVE_BLOCK' });
    await expect(
      denied.service.request(
        row.requesterAccountId,
        { recipient_account_id: row.recipientAccountId, mode: 'friends' },
        'request-00000001',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(denied.repository.createRequest).not.toHaveBeenCalled();
  });

  it('uses layered account/pair limiting before a request mutation', async () => {
    const { service, limiter, repository } = setup();
    limiter.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 20 });
    await expect(
      service.request(
        row.requesterAccountId,
        { recipient_account_id: row.recipientAccountId, mode: 'friends' },
        'request-00000002',
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(repository.createRequest).not.toHaveBeenCalled();
    expect(limiter.consume).toHaveBeenCalledTimes(2);
  });

  it('maps repository idempotency conflict to stable 409', async () => {
    const { service, repository } = setup();
    repository.transition.mockRejectedValue(new Error('IDEMPOTENCY_CONFLICT'));
    await expect(
      service.action(row.requesterAccountId, row.id, 'disconnect', 'action-00000001'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('replays a request before rate limits or pair policy checks', async () => {
    const { service, repository, limiter, gate } = setup();
    repository.replayCreateRequest.mockResolvedValue(row);
    await expect(
      service.request(
        row.requesterAccountId,
        { recipient_account_id: row.recipientAccountId, mode: 'friends' },
        'request-replay-0001',
      ),
    ).resolves.toMatchObject({ id: row.id });
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(gate.check).not.toHaveBeenCalled();
    expect(repository.createRequest).not.toHaveBeenCalled();
  });

  it('replays a frozen action before graph and policy checks, including after invalidation', async () => {
    const { service, repository, gate } = setup();
    repository.replayTransition.mockResolvedValue({ ...row, state: 'disconnected' });
    repository.getForActor.mockResolvedValue(null);
    gate.check.mockResolvedValue({ allowed: false, reason: 'POLICY_UNAVAILABLE' });
    await expect(
      service.action(row.requesterAccountId, row.id, 'disconnect', 'action-replay-0001'),
    ).resolves.toMatchObject({ state: 'disconnected' });
    expect(repository.getForActor).not.toHaveBeenCalled();
    expect(gate.check).not.toHaveBeenCalled();
  });

  it('allows decline and disconnect to escape when the peer policy provider is unavailable', async () => {
    const { service, repository, gate } = setup();
    gate.check.mockResolvedValue({ allowed: false, reason: 'POLICY_UNAVAILABLE' });
    repository.getForActor.mockResolvedValue({ ...row, state: 'pending', acceptedAt: undefined });
    repository.transition.mockResolvedValueOnce({ ...row, state: 'declined' });
    await expect(
      service.action(row.recipientAccountId, row.id, 'decline', 'action-escape-0001'),
    ).resolves.toMatchObject({ state: 'declined' });
    expect(gate.check).not.toHaveBeenCalled();
    repository.getForActor.mockResolvedValue(row);
    repository.transition.mockResolvedValueOnce({ ...row, state: 'disconnected' });
    await expect(
      service.action(row.requesterAccountId, row.id, 'disconnect', 'action-escape-0002'),
    ).resolves.toMatchObject({ state: 'disconnected' });
    expect(gate.check).not.toHaveBeenCalled();
  });

  it('returns a bounded page and next cursor', async () => {
    const { service, repository } = setup();
    repository.listForActor.mockResolvedValue({ rows: [row], nextCursor: 'next-opaque' });
    await expect(service.list(row.requesterAccountId, { limit: 1 })).resolves.toMatchObject({
      connections: [{ id: row.id }],
      next_cursor: 'next-opaque',
    });
    expect(repository.listForActor).toHaveBeenCalledWith(row.requesterAccountId, {
      limit: 1,
      cursor: undefined,
    });
  });

  it('filters a peer denied by the gate without filling the page from an unauthorized row', async () => {
    const { service, repository, gate } = setup();
    repository.listForActor.mockResolvedValue({ rows: [row], nextCursor: 'more' });
    gate.check.mockResolvedValue({ allowed: false, reason: 'COMMUNITY_ACCESS_DENIED' });
    await expect(service.list(row.requesterAccountId, { limit: 1 })).resolves.toEqual({
      connections: [],
      next_cursor: 'more',
    });
  });
});
