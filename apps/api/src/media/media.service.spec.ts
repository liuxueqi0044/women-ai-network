import { describe, expect, it } from 'vitest';
import { MemoryMediaStorage, OwnerMediaAuthorization } from './media.adapters.js';
import { MediaAccessTokenService, MediaService } from './media.service.js';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const baseRow = (state: 'reserved' | 'clean' = 'reserved') => ({
  assetId: '33333333-3333-4333-8333-333333333333',
  ownerId: owner,
  purpose: 'profile_avatar' as const,
  state,
  detectedType: state === 'clean' ? ('image/jpeg' as const) : null,
  sha256: null,
  retentionState: 'active' as const,
  quarantineKeyDigest: 'a'.repeat(64),
  rendition:
    state === 'clean'
      ? {
          variant: 'clean' as const,
          contentType: 'image/jpeg' as const,
          width: 4,
          height: 3,
          bytes: 100,
        }
      : null,
});

function service(row = baseRow()) {
  const repository = {
    asset: async () => row,
    status: async () => row,
    recordAccess: async (...args: unknown[]) => {
      void args;
    },
  } as never;
  return new MediaService(
    repository,
    new MemoryMediaStorage(),
    new OwnerMediaAuthorization(),
    new MediaAccessTokenService(new Uint8Array(32).fill(7)),
    () => 'quarantine/server-key',
    (value) => value.padEnd(64, '0').slice(0, 64),
  );
}

describe('MED-01 access boundary', () => {
  it('never delivers unscanned media', async () => {
    await expect(
      service().accessAsset({
        viewerId: owner,
        assetId: baseRow().assetId,
        purpose: 'profile_avatar',
      }),
    ).rejects.toThrow('Media not found');
  });

  it('denies IDOR before issuing a capability', async () => {
    await expect(
      service(baseRow('clean')).accessAsset({
        viewerId: other,
        assetId: baseRow('clean').assetId,
        purpose: 'profile_avatar',
      }),
    ).rejects.toThrow('Media access denied');
  });

  it('issues a bounded capability that expires', async () => {
    const now = new Date('2026-08-18T00:00:00.000Z');
    const result = await service(baseRow('clean')).accessAsset({
      viewerId: owner,
      assetId: baseRow('clean').assetId,
      purpose: 'profile_avatar',
      now,
    });
    expect(result.expiresAt.getTime() - now.getTime()).toBe(60_000);
    expect(
      new MediaAccessTokenService(new Uint8Array(32).fill(7)).verify(
        result.token,
        result.expiresAt.getTime() + 1,
      ),
    ).toBeNull();
  });

  it('rechecks clean state and viewer when redeeming a capability', async () => {
    const now = new Date('2026-08-18T00:00:00.000Z');
    const clean = baseRow('clean');
    const instance = service(clean);
    const issued = await instance.accessAsset({
      viewerId: owner,
      assetId: clean.assetId,
      purpose: 'profile_avatar',
      now,
    });
    await expect(
      instance.redeemAccess({
        viewerId: other,
        assetId: clean.assetId,
        token: issued.token,
        purpose: 'profile_avatar',
        now,
      }),
    ).rejects.toThrow('Media access denied');
    await expect(
      instance.redeemAccess({
        viewerId: owner,
        assetId: clean.assetId,
        token: issued.token,
        purpose: 'profile_avatar',
        now: new Date(issued.expiresAt.getTime() + 1),
      }),
    ).rejects.toThrow('Media access denied');
  });
});
