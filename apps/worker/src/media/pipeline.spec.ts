import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MediaObjectKeys } from './keys.js';
import { MemoryMediaStorage } from './object-storage.js';
import { MediaPipeline } from './pipeline.js';
import { DeterministicMalwareScanner } from './scanner.js';
import { SharpImageSanitizer } from './sharp-sanitizer.js';
import { AllowAllMediaContentModerator } from '@wai/media-infra';

const assetId = '33333333-3333-4333-8333-333333333333';

describe('MED-01 durable processing pipeline', () => {
  it('executes scan, sharp re-encode, clean publication and quarantine deletion', async () => {
    const keys = new MediaObjectKeys(new Uint8Array(32).fill(9));
    const storage = new MemoryMediaStorage();
    const source = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'blue' } })
      .jpeg()
      .toBuffer();
    storage.seed(keys.quarantine(assetId), source);
    const calls: string[] = [];
    const repository = {
      asset: async () => ({
        assetId,
        ownerId: 'owner',
        purpose: 'profile_avatar' as const,
        state: 'uploaded' as const,
        detectedType: 'image/jpeg' as const,
        sha256: null,
        retentionState: 'active' as const,
        quarantineKeyDigest: keys.digest('quarantine', assetId),
      }),
      advanceStage: async (input: { to: string }) => {
        calls.push(input.to);
        return true;
      },
      publishRendition: async () => {
        calls.push('clean');
        return true;
      },
      finishJob: async () => true,
    } as never;
    const pipeline = new MediaPipeline(
      repository,
      storage,
      new DeterministicMalwareScanner(),
      new AllowAllMediaContentModerator(),
      new SharpImageSanitizer(),
      keys,
    );
    const result = await pipeline.process({
      jobId: '44444444-4444-4444-8444-444444444444',
      assetId,
      leaseToken: '55555555-5555-4555-8555-555555555555',
    });
    expect(result).toBe('clean');
    expect(calls).toEqual(['scanning', 'sanitizing', 'clean']);
    expect(storage.has(keys.quarantine(assetId))).toBe(false);
    expect(storage.has(keys.clean(assetId))).toBe(true);
  });

  it('does not complete a job when publication loses its lease', async () => {
    const keys = new MediaObjectKeys(new Uint8Array(32).fill(8));
    const storage = new MemoryMediaStorage();
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer();
    storage.seed(keys.quarantine(assetId), source);
    const repository = {
      asset: async () => ({
        assetId,
        ownerId: 'owner',
        purpose: 'profile_avatar' as const,
        state: 'uploaded' as const,
        detectedType: 'image/png' as const,
        sha256: null,
        retentionState: 'active' as const,
        quarantineKeyDigest: keys.digest('quarantine', assetId),
      }),
      advanceStage: async () => true,
      publishRendition: async () => false,
      finishJob: async () => true,
    } as never;
    const result = await new MediaPipeline(
      repository,
      storage,
      new DeterministicMalwareScanner(),
      new AllowAllMediaContentModerator(),
      new SharpImageSanitizer(),
      keys,
    ).process({
      jobId: '44444444-4444-4444-8444-444444444444',
      assetId,
      leaseToken: '66666666-6666-4666-8666-666666666666',
    });
    expect(result).toBe('retryable');
    expect(storage.has(keys.quarantine(assetId))).toBe(true);
  });

  it.each([
    ['block' as const, 'rejected' as const],
    ['review' as const, 'rejected' as const],
    ['unavailable' as const, 'retryable' as const],
  ])('never publishes when visual review returns %s', async (decision, expected) => {
    const keys = new MediaObjectKeys(new Uint8Array(32).fill(7));
    const storage = new MemoryMediaStorage();
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    })
      .jpeg()
      .toBuffer();
    storage.seed(keys.quarantine(assetId), source);
    let published = 0;
    let finishInput: { state?: string; errorCode?: string } | undefined;
    const repository = {
      asset: async () => ({
        assetId,
        ownerId: 'owner',
        purpose: 'profile_gallery' as const,
        state: 'uploaded' as const,
        detectedType: 'image/jpeg' as const,
        sha256: null,
        retentionState: 'active' as const,
        quarantineKeyDigest: keys.digest('quarantine', assetId),
      }),
      advanceStage: async () => true,
      publishRendition: async () => {
        published += 1;
        return true;
      },
      finishJob: async (value: { state?: string; errorCode?: string }) => {
        finishInput = value;
        return true;
      },
    } as never;
    const result = await new MediaPipeline(
      repository,
      storage,
      new DeterministicMalwareScanner(),
      {
        review: async () => ({
          decision,
          reasonCodes: decision === 'block' ? (['SEXUAL_CONTENT'] as const) : [],
        }),
      },
      new SharpImageSanitizer(),
      keys,
    ).process({
      jobId: '44444444-4444-4444-8444-444444444444',
      assetId,
      leaseToken: '77777777-7777-4777-8777-777777777777',
    });
    expect(result).toBe(expected);
    expect(published).toBe(0);
    expect(storage.has(keys.clean(assetId))).toBe(false);
    expect(finishInput?.state).toBe(expected);
    if (decision === 'unavailable') expect(finishInput?.errorCode).toBe('SCANNER_UNAVAILABLE');
    else expect(finishInput).not.toHaveProperty('errorCode');
  });
});
