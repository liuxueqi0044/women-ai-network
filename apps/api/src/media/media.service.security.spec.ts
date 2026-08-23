import { describe, expect, it } from 'vitest';
import type { QueueProducerAdapter } from '../infra/adapters.js';
import { MemoryMediaStorage, OwnerMediaAuthorization } from './media.adapters.js';
import { MediaAccessTokenService, MediaHttpException, MediaService } from './media.service.js';

const owner = '11111111-1111-4111-8111-111111111111';
const asset = '33333333-3333-4333-8333-333333333333';
const base = (state: 'reserved' | 'clean' = 'reserved') => ({
  assetId: asset,
  ownerId: owner,
  purpose: 'profile_avatar' as const,
  state,
  declaredSize: 100,
  declaredType: 'image/jpeg',
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

function make(
  repository: Record<string, unknown>,
  storage = new MemoryMediaStorage(),
  clean = (id: string) => `clean/${id}`,
  queue?: QueueProducerAdapter,
  uploadsEnabled = true,
) {
  return new MediaService(
    repository as never,
    storage,
    new OwnerMediaAuthorization(),
    new MediaAccessTokenService(new Uint8Array(32).fill(3)),
    (id) => `quarantine/${id}`,
    (value) => value.padEnd(64, '0').slice(0, 64),
    clean,
    queue,
    uploadsEnabled,
  );
}

describe('MED-01 service regressions', () => {
  it('rejects disabled uploads before creating or reading an authority row', async () => {
    let repositoryCalls = 0;
    const instance = make(
      {
        createIntent: async () => {
          repositoryCalls += 1;
        },
        asset: async () => {
          repositoryCalls += 1;
        },
      },
      new MemoryMediaStorage(),
      undefined,
      undefined,
      false,
    );
    await expect(
      instance.createIntent({
        ownerId: owner,
        purpose: 'profile_avatar',
        declaredSize: 100,
        idempotencyKey: 'disabled-create-key',
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'MEDIA_PROVIDER_UNAVAILABLE' },
    });
    await expect(
      instance.completeIntent({
        ownerId: owner,
        assetId: asset,
        idempotencyKey: 'disabled-complete-key',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(repositoryCalls).toBe(0);
  });

  it('replay uses the old asset id when deriving the upload target', async () => {
    const storage = new MemoryMediaStorage();
    const oldAsset = '44444444-4444-4444-8444-444444444444';
    const service = make(
      {
        createIntent: async () => ({
          created: false,
          assetId: oldAsset,
          state: 'reserved',
          quarantineKeyDigest: 'a'.repeat(64),
          expiresAt: new Date('2026-08-18T01:00:00Z'),
        }),
      },
      storage,
    );
    const result = await service.createIntent({
      ownerId: owner,
      purpose: 'profile_avatar',
      declaredSize: 100,
      idempotencyKey: 'same-key-123',
    });
    expect(result.upload_target).toContain(oldAsset);
  });

  it('replays completion after quarantine deletion without reading the object again', async () => {
    const service = make(
      {
        asset: async () => ({ ...base(), state: 'clean' }),
        findCompleteReplay: async () => ({ state: 'clean', jobId: null }),
      },
      {
        stat: async () => {
          throw new Error('must not read deleted quarantine');
        },
      } as never,
    );
    await expect(
      service.completeIntent({
        ownerId: owner,
        assetId: asset,
        idempotencyKey: 'complete-key-123',
      }),
    ).resolves.toEqual({ state: 'clean', jobId: null });
  });

  it('rejects declared size and content-type mismatches before queueing', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const storage = new MemoryMediaStorage();
    storage.seed(`quarantine/${asset}`, bytes);
    const repository = {
      asset: async () => ({
        ...base(),
        declaredSize: bytes.byteLength,
        declaredType: 'image/png',
      }),
      findCompleteReplay: async () => null,
    };
    await expect(
      make(repository, storage).completeIntent({
        ownerId: owner,
        assetId: asset,
        idempotencyKey: 'complete-key-123',
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'MEDIA_INVALID_UPLOAD' } });
  });

  it('maps repository/provider failures to stable HTTP and keeps delivery two-phase', async () => {
    const service = make({ status: async () => null, recordAccess: async () => undefined });
    await expect(
      service.accessAsset({ viewerId: owner, assetId: asset, purpose: 'profile_avatar' }),
    ).rejects.toBeInstanceOf(MediaHttpException);
    await expect(
      make({
        status: async () => {
          throw new Error('db unavailable');
        },
      }).status(asset, owner),
    ).rejects.toMatchObject({ status: 503, response: { code: 'MEDIA_PROVIDER_UNAVAILABLE' } });
    const upload = new Uint8Array(100);
    upload.set([0xff, 0xd8, 0xff], 0);
    upload.set([0xff, 0xd9], upload.length - 2);
    const conflictStorage = new MemoryMediaStorage();
    conflictStorage.seed(`quarantine/${asset}`, upload);
    await expect(
      make(
        {
          asset: async () => base(),
          findCompleteReplay: async () => null,
          completeIntent: async () => {
            throw new Error('media_idempotency_conflict');
          },
        },
        conflictStorage,
      ).completeIntent({ ownerId: owner, assetId: asset, idempotencyKey: 'complete-key-123' }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'MEDIA_CONFLICT' } });
    const row = base('clean');
    const cleanStorage = new MemoryMediaStorage();
    const twoPhase = make(
      { status: async () => row, recordAccess: async () => undefined },
      cleanStorage,
      () => 'clean/server-key',
    );
    const capability = await twoPhase.accessAsset({
      viewerId: owner,
      assetId: asset,
      purpose: 'profile_avatar',
    });
    expect(capability).not.toHaveProperty('deliveryTarget');
    const redeemed = await twoPhase.redeemAccess({
      viewerId: owner,
      assetId: asset,
      token: capability.token,
      purpose: 'profile_avatar',
    });
    expect(redeemed.deliveryTarget).toContain('clean%2Fserver-key');
  });

  it('status is a public DTO with no owner/hash/object key fields', async () => {
    const result = await make({ status: async () => base('clean') }).status(asset, owner);
    expect(result).toEqual(expect.objectContaining({ asset_id: asset, state: 'clean' }));
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('sha256');
    expect(result).not.toHaveProperty('quarantineKeyDigest');
  });

  it('dispatches first completion and replay as the same durable queue wake-up', async () => {
    const bytes = new Uint8Array(100);
    bytes.set([0xff, 0xd8, 0xff], 0);
    bytes.set([0xff, 0xd9], bytes.length - 2);
    const storage = new MemoryMediaStorage();
    storage.seed(`quarantine/${asset}`, bytes);
    const jobs: Array<{ name: string; id: string; data: unknown }> = [];
    const queue: QueueProducerAdapter = {
      enqueue: async (name, data, options) => {
        jobs.push({ name, id: options.jobId, data });
      },
      check: async () => true,
      close: async () => undefined,
    };
    const jobId = '55555555-5555-4555-8555-555555555555';
    const first = make(
      {
        asset: async () => base(),
        findCompleteReplay: async () => null,
        completeIntent: async () => ({ state: 'uploaded' as const, jobId }),
      },
      storage,
      undefined,
      queue,
    );
    await first.completeIntent({ ownerId: owner, assetId: asset, idempotencyKey: 'same-complete' });
    const replay = make(
      {
        asset: async () => ({ ...base(), state: 'uploaded' as const }),
        findCompleteReplay: async () => ({ state: 'uploaded' as const, jobId }),
      },
      storage,
      undefined,
      queue,
    );
    await replay.completeIntent({
      ownerId: owner,
      assetId: asset,
      idempotencyKey: 'same-complete',
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.name === 'media.process')).toBe(true);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(jobs.every((job) => (job.data as { job_id: string }).job_id === jobId)).toBe(true);
  });
});
