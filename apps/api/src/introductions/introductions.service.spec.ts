import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IntroductionIdempotencyConflictError } from '@wai/db';
import type {
  IntroductionCandidateRecord,
  IntroductionHistoryResponse,
  IntroductionRepositoryPort,
} from '@wai/contracts';
import { IntroductionsController } from './introductions.controller.js';
import { IntroductionsService } from './introductions.service.js';

const actor = '11111111-1111-4111-8111-111111111111';
const batch = '22222222-2222-4222-8222-222222222222';
const firstId = '33333333-3333-4333-8333-333333333333';
const secondId = '44444444-4444-4444-8444-444444444444';

function candidate(id: string): IntroductionCandidateRecord {
  return {
    id,
    batchId: batch,
    actorAccountId: actor,
    subjectAccountId:
      id === firstId
        ? '55555555-5555-4555-8555-555555555555'
        : '66666666-6666-4666-8666-666666666666',
    mode: 'friends',
    reasons: ['PREFERENCES_ALIGN'],
    visibleFacts: [],
    score: 1,
    decision: null,
    actorDecisionAt: null,
    subjectDecisionAt: null,
    outcome: null,
    subjectCard: { displayName: 'Safe member' },
  };
}

function makeService(
  repo: Partial<IntroductionRepositoryPort>,
  gate: {
    check: (input: {
      allowExistingMutual?: boolean;
    }) => Promise<{ allowed: boolean; reason?: 'POLICY_DENIED' }>;
  },
) {
  return new IntroductionsService(repo as IntroductionRepositoryPort, gate as never, {
    consume: async () => ({ allowed: true }),
  });
}

describe('MCH-01 service and controller barriers', () => {
  it('binds the idempotency digest to the introduction path', async () => {
    const digests: string[] = [];
    let replay = false;
    const repo: Partial<IntroductionRepositoryPort> = {
      findCandidate: async (_account, id) => candidate(id),
      decide: async (input) => {
        digests.push(input.payloadDigest);
        if (replay) throw new IntroductionIdempotencyConflictError();
        replay = true;
        return {
          row: candidate(input.introductionId),
          outcome: null,
          actorProof: 'a',
          subjectProof: null,
        };
      },
    };
    const service = makeService(repo, { check: async () => ({ allowed: true }) });
    await service.decide(
      actor,
      firstId,
      { batch_id: batch, decision: 'pass' },
      'idem-key-00000001',
    );
    await expect(
      service.decide(actor, secondId, { batch_id: batch, decision: 'pass' }, 'idem-key-00000001'),
    ).rejects.toMatchObject({ status: 409 });
    expect(digests[0]).not.toBe(digests[1]);
  });

  it('applies a final decision gate after the repository returns', async () => {
    const repo: Partial<IntroductionRepositoryPort> = {
      findCandidate: async () => candidate(firstId),
      decide: async (input) => ({
        row: candidate(input.introductionId),
        outcome: null,
        actorProof: 'a',
        subjectProof: null,
      }),
    };
    const checks = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: 'POLICY_DENIED' });
    const service = makeService(repo, { check: checks });
    await expect(
      service.decide(actor, firstId, { batch_id: batch, decision: 'pass' }, 'idem-key-00000002'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(checks).toHaveBeenCalledTimes(2);
  });

  it('filters history again at the response boundary', async () => {
    const item = (id: string): IntroductionHistoryResponse['items'][number] => ({
      id,
      mode: 'friends' as const,
      subject: { display_name: 'Safe member' },
      reasons: ['PREFERENCES_ALIGN'],
      explanation: 'Current preferences are compatible.',
      decision: 'pass' as const,
      outcome: null,
    });
    const repo: Partial<IntroductionRepositoryPort> = {
      history: async () => ({ items: [item(firstId), item(secondId)], next_cursor: null }),
      findCandidate: async (_account, id) => candidate(id),
    };
    const checks = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: 'POLICY_DENIED' });
    const service = makeService(repo, { check: checks });
    const result = await service.history(actor, {});
    expect(result.items.map((entry) => entry.id)).toEqual([firstId]);
  });

  it('rejects a missing idempotency key as a stable 400', () => {
    const service = { decide: vi.fn() } as never;
    const controller = new IntroductionsController(service);
    try {
      controller.pass({ accountId: actor } as never, firstId, { batch_id: batch }, undefined);
      throw new Error('expected BadRequestException');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
    }
    expect((service as { decide: ReturnType<typeof vi.fn> }).decide).not.toHaveBeenCalled();
  });
});
