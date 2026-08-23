import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SafetyService } from './safety.service.js';

const input = {
  subject_account_id: '72222222-2222-4222-8222-222222222222',
  target_type: 'account' as const,
  target_id: 'target-1',
  category: 'other' as const,
  idempotency_key: 'report-000000000001',
};
const snapshot = {
  schemaVersion: 1 as const,
  targetType: 'account' as const,
  reference: { targetType: 'account' as const, targetId: 'target-1', sourceVersion: null },
  capturedAt: new Date().toISOString(),
  category: 'other' as const,
  safeMetadata: { account_state: 'active' as const },
};
function service(captured: unknown) {
  const repo = {
    createReport: vi.fn().mockResolvedValue({
      id: '73333333-3333-4333-8333-333333333333',
      state: 'open',
      createdAt: new Date(),
      existing: false,
    }),
  };
  const evidence = { capture: vi.fn().mockResolvedValue(captured) };
  return { instance: new SafetyService(repo as never, evidence as never), repo, evidence };
}
describe('SafetyService report evidence fail-closed boundary', () => {
  it.each([
    null,
    { ...snapshot, schemaVersion: 999 },
    { ...snapshot, targetType: 'profile' },
    { ...snapshot, reference: { ...snapshot.reference, targetId: 'other' } },
    { ...snapshot, category: 'threats' },
  ])('maps invalid provider result to one NOT_FOUND', async (captured) => {
    const x = service(captured);
    await expect(
      x.instance.report('71111111-1111-4111-8111-111111111111', input),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(x.repo.createReport).not.toHaveBeenCalled();
  });
  it('passes only a matching validated snapshot to the repository', async () => {
    const x = service(snapshot);
    await expect(
      x.instance.report('71111111-1111-4111-8111-111111111111', input),
    ).resolves.toMatchObject({ state: 'open' });
    expect(x.repo.createReport).toHaveBeenCalledOnce();
    expect(x.evidence.capture).toHaveBeenCalledWith(
      expect.anything(),
      '71111111-1111-4111-8111-111111111111',
      input.subject_account_id,
      input.category,
    );
  });
});
