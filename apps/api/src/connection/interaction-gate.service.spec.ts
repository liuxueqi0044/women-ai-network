import { describe, expect, it, vi } from 'vitest';
import { InteractionGateService } from './interaction-gate.service.js';

const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
function setup() {
  const community = { decide: vi.fn().mockResolvedValue({ decision: 'eligible', reasons: [] }) };
  const partition = { decide: vi.fn().mockResolvedValue({ decision: 'allow' }) };
  const safety = { isInteractionAllowed: vi.fn().mockResolvedValue({ allowed: true }) };
  const graph = {
    relationship: vi.fn().mockResolvedValue({ relationship: 'connection' }),
    getForActor: vi.fn().mockResolvedValue(null),
  };
  return {
    service: new InteractionGateService(community, partition, safety, graph),
    community,
    partition,
    safety,
    graph,
  };
}

describe('CON-01 InteractionGate', () => {
  it('combines both community decisions, ELG partition, surface and SAF block', async () => {
    const { service, community, partition, safety } = setup();
    await expect(
      service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'introduce',
        mode: 'friends',
        surface: 'matching',
      }),
    ).resolves.toEqual({ allowed: true });
    expect(community.decide).toHaveBeenCalledTimes(2);
    expect(partition.decide).toHaveBeenCalledWith(ids[0], ids[1], { capability: 'introduce' });
    expect(safety.isInteractionAllowed).toHaveBeenCalledWith(ids[0], ids[1], 'matching');
  });

  it('fails closed on either community denial, partition denial or active block', async () => {
    const deniedCommunity = setup();
    deniedCommunity.community.decide.mockResolvedValueOnce({ decision: 'denied', reasons: [] });
    await expect(
      deniedCommunity.service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'introduce',
        mode: 'friends',
        surface: 'matching',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'COMMUNITY_ACCESS_DENIED' });
    const deniedPartition = setup();
    deniedPartition.partition.decide.mockResolvedValue({ decision: 'deny' });
    await expect(
      deniedPartition.service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'introduce',
        mode: 'friends',
        surface: 'matching',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'PARTITION_DENIED' });
    const blocked = setup();
    blocked.safety.isInteractionAllowed.mockResolvedValue({
      allowed: false,
      reason: 'ACTIVE_BLOCK',
    });
    await expect(
      blocked.service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'introduce',
        mode: 'friends',
        surface: 'matching',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'ACTIVE_BLOCK' });
  });

  it('requires a live accepted graph edge when requested', async () => {
    const { service, graph } = setup();
    graph.relationship.mockResolvedValue({ relationship: 'none' });
    await expect(
      service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'introduce',
        mode: 'friends',
        surface: 'profile',
        requireConnection: true,
      }),
    ).resolves.toEqual({ allowed: false, reason: 'PARTITION_DENIED' });
  });

  it('binds an exact connection id and accepted epoch when supplied', async () => {
    const { service, graph } = setup();
    graph.getForActor = vi.fn().mockResolvedValue({
      requesterAccountId: ids[0],
      recipientAccountId: ids[1],
      mode: 'friends',
      state: 'accepted',
      version: 4,
    });
    await expect(
      service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'direct_message',
        mode: 'friends',
        surface: 'chat',
        requireConnection: true,
        connectionId: '00000000-0000-4000-8000-000000000010',
        acceptedEpoch: 3,
      }),
    ).resolves.toEqual({ allowed: false, reason: 'PARTITION_DENIED' });
    await expect(
      service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'direct_message',
        mode: 'friends',
        surface: 'chat',
        requireConnection: true,
        connectionId: '00000000-0000-4000-8000-000000000010',
        acceptedEpoch: 4,
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it('fails closed when the required exact connection lookup is unavailable', async () => {
    const { service, graph } = setup();
    graph.getForActor.mockRejectedValue(new Error('connection lookup unavailable'));
    await expect(
      service.check({
        actorAccountId: ids[0]!,
        subjectAccountId: ids[1]!,
        capability: 'direct_message',
        mode: 'friends',
        surface: 'chat',
        requireConnection: true,
        connectionId: '00000000-0000-0000-0000-000000000010',
        acceptedEpoch: 1,
      }),
    ).resolves.toEqual({ allowed: false, reason: 'POLICY_UNAVAILABLE' });
  });
});
