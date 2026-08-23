import { describe, expect, it, vi } from 'vitest';
import { ProfileController, PublicProfileController } from './profile.controller.js';

const session = { accountId: '11111111-1111-4111-8111-111111111111' } as never;
const mutation = {
  profile_id: '22222222-2222-4222-8222-222222222222',
  version: 1,
  state: 'draft' as const,
};

describe('PRF-01 HTTP mutation contract', () => {
  it('returns stable 4xx for missing/invalid precondition and idempotency headers', async () => {
    const service = { update: vi.fn().mockResolvedValue(mutation) };
    const controller = new ProfileController(service as never);
    await expect(
      controller.update(session, { display_name: 'A' }, undefined, 'valid-idempotency-key'),
    ).rejects.toMatchObject({ status: 428 });
    await expect(
      controller.update(session, { display_name: 'A' }, 'not-a-version', 'valid-idempotency-key'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.update(session, { display_name: 'A' }, '0', 'short'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('allows the first write without a preceding GET and never returns decrypted facts', async () => {
    const service = { update: vi.fn().mockResolvedValue(mutation) };
    const controller = new ProfileController(service as never);
    const response = await controller.update(
      session,
      { display_name: 'A' },
      '0',
      'valid-idempotency-key',
    );
    expect(response).toEqual(mutation);
    expect(response).not.toHaveProperty('facts');
    expect(service.update).toHaveBeenCalledOnce();
  });

  it('rejects malformed public profile ids with a stable 400 before reaching the database', async () => {
    const service = { viewerView: vi.fn() };
    const controller = new PublicProfileController(service as never);
    expect(() => controller.view(session, 'not-a-uuid', {})).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(service.viewerView).not.toHaveBeenCalled();
  });
});
