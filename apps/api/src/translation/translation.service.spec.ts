import { describe, expect, it, vi } from 'vitest';
import type {
  TranslationProvider,
  TranslationRepositoryPort,
  TranslationSourcePort,
} from '@wai/contracts';
import type { AppConfig } from '@wai/config';
import { TranslationIdempotencyConflictError } from '@wai/db';
import { TranslationService } from './translation.service.js';

const owner = '11111111-1111-4111-8111-111111111111';
const letter = '22222222-2222-4222-8222-222222222222';
const source = {
  letterId: letter,
  ownerId: owner,
  kind: 'public_letter' as const,
  state: 'published' as const,
  currentRevision: 1,
  revisionId: '33333333-3333-4333-8333-333333333333',
  revision: 1,
  sourceHash: 'a'.repeat(64),
  revisionCreatedAt: new Date(),
  content: {
    title: 'Hello',
    body: { paragraphs: ['World'] },
    locale: 'en-US',
    country_code: 'US',
    topics: ['life_story'],
    content_reminder: 'none',
    pen_name: 'A',
  },
};
const config = { iam: { secretPepper: Buffer.alloc(32, 1).toString('base64') } } as AppConfig;

function setup() {
  const repo = {
    replay: vi.fn().mockResolvedValue(null),
    saveFallbackReplay: vi.fn(async ({ fallback }: { fallback: unknown }) => fallback),
    createOrReplay: vi.fn().mockResolvedValue({
      created: true,
      task: {
        id: '44444444-4444-4444-8444-444444444444',
        state: 'queued',
        key: {
          source_kind: 'public_letter',
          letter_id: letter,
          source_revision_id: source.revisionId,
          source_revision: 1,
          source_hash: source.sourceHash,
          source_locale: 'en-US',
          target_locale: 'fr-FR',
          provider_id: 'test',
          provider_version: 'v1',
        },
      },
    }),
    findLatest: vi.fn(),
    read: vi.fn(),
    currentConsent: vi.fn(),
  } as unknown as TranslationRepositoryPort;
  const sourcePort = {
    readPublicSource: vi.fn().mockResolvedValue(source),
    readPrivateSource: vi.fn().mockResolvedValue(null),
  } as unknown as TranslationSourcePort;
  const queue = { enqueue: vi.fn().mockResolvedValue(undefined), check: vi.fn(), close: vi.fn() };
  const limiter = { consume: vi.fn().mockResolvedValue({ allowed: true }) };
  const providers = new Map<string, TranslationProvider>();
  const service = new TranslationService(repo, sourcePort, providers, queue, limiter, config);
  return { service, repo, sourcePort, queue, limiter, providers };
}

describe('TranslationService security boundaries', () => {
  it('returns original source when no provider is configured without exposing a task', async () => {
    const { service, repo, queue, limiter } = setup();
    const result = await service.request(
      owner,
      { letter_id: letter, target_locale: 'fr-FR' },
      'translation-idempotency-001',
    );
    expect(result.machine_translated).toBe(false);
    expect(repo.createOrReplay).not.toHaveBeenCalled();
    expect(repo.saveFallbackReplay).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it('private_translation_requires_explicit_provider_consent', async () => {
    const { service, sourcePort, providers, repo } = setup();
    const privateSource = {
      ...source,
      kind: 'private_letter' as const,
    } as unknown as NonNullable<Awaited<ReturnType<TranslationSourcePort['readPrivateSource']>>>;
    vi.mocked(sourcePort.readPublicSource).mockResolvedValue(null);
    vi.mocked(sourcePort.readPrivateSource).mockResolvedValue(privateSource);
    providers.set('private-test', {
      capability: {
        provider_id: 'private-test',
        provider_version: 'v1',
        processing_regions: ['us'],
        no_training: true,
        retention_seconds: 0,
        retention_policy: 'zero',
        supports_private: true,
      },
      translate: vi.fn(),
    });
    vi.mocked(repo.currentConsent).mockResolvedValue(null);

    await expect(
      service.request(
        owner,
        { letter_id: letter, target_locale: 'fr-FR', provider_id: 'private-test' },
        'private-consent-key',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.createOrReplay).not.toHaveBeenCalled();
  });

  it('maps idempotency conflicts before provider or queue side effects', async () => {
    const { service, repo, queue } = setup();
    vi.mocked(repo.replay).mockRejectedValue(new TranslationIdempotencyConflictError());
    await expect(
      service.request(
        owner,
        { letter_id: letter, target_locale: 'fr-FR' },
        'translation-idempotency-002',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('rechecks the current source before replaying or re-enqueuing a frozen task', async () => {
    const { service, repo, sourcePort, queue } = setup();
    vi.mocked(repo.replay).mockResolvedValue({
      task: {
        id: '55555555-5555-4555-8555-555555555555',
        ownerId: owner,
        key: {
          source_kind: 'public_letter',
          letter_id: letter,
          source_revision_id: source.revisionId,
          source_revision: 1,
          source_hash: source.sourceHash,
          source_locale: 'en-US',
          target_locale: 'fr-FR',
          provider_id: 'test',
          provider_version: 'v1',
        },
        requestDigest: 'a'.repeat(64),
        state: 'queued',
        attempts: 0,
        maxAttempts: 3,
        leaseToken: null,
        nextRetryAt: null,
        leaseUntil: null,
        lastErrorCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    vi.mocked(sourcePort.readPublicSource).mockResolvedValue(null);
    vi.mocked(sourcePort.readPrivateSource).mockResolvedValue(null);

    await expect(
      service.request(owner, { letter_id: letter, target_locale: 'fr-FR' }, 'replay-key-001'),
    ).rejects.toMatchObject({ status: 404 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('stale_revision_translation_cannot_appear_as_current', async () => {
    const { service, repo } = setup();
    vi.mocked(repo.findLatest).mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      ownerId: owner,
      key: {
        source_kind: 'public_letter',
        letter_id: letter,
        source_revision_id: source.revisionId,
        source_revision: 1,
        source_hash: 'f'.repeat(64),
        source_locale: 'en-US',
        target_locale: 'fr-FR',
        provider_id: 'test',
        provider_version: 'v1',
      },
      requestDigest: 'a'.repeat(64),
      state: 'ready',
      attempts: 1,
      maxAttempts: 3,
      leaseToken: null,
      nextRetryAt: null,
      leaseUntil: null,
      lastErrorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(service.read(owner, letter, 'fr-FR')).rejects.toMatchObject({ status: 404 });
    expect(repo.read).not.toHaveBeenCalled();
  });
});
