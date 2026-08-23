import { describe, expect, it, vi } from 'vitest';
import { LetterIdempotencyConflictError } from '@wai/db';
import { LettersService } from './letters.service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const LETTER = '33333333-3333-4333-8333-333333333333';

const record = {
  id: LETTER,
  ownerId: OWNER,
  kind: 'public_letter' as const,
  state: 'draft' as const,
  version: 1,
  revision: 1,
  content: {
    title: 'Hello',
    body: { paragraphs: ['World'] },
    locale: 'en-US',
    country_code: 'US',
    topics: ['friendship' as const],
    content_reminder: 'none' as const,
    pen_name: 'Aurora',
  },
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function makeService(
  ageBand: 'adult' | 'youth' | null = 'adult',
  community = 'eligible',
  allowed = true,
  partitionDecision: 'allow' | 'deny' = 'allow',
) {
  const repo = {
    create: vi.fn(),
    autosave: vi.fn(),
    publish: vi.fn().mockResolvedValue({ ...record, state: 'published', version: 2 }),
    withdraw: vi.fn(),
    archive: vi.fn(),
    getOwned: vi.fn().mockResolvedValue(null),
    getPublished: vi.fn(),
    listOwned: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    replay: vi.fn().mockResolvedValue(null),
  };
  const rateLimiter = { consume: vi.fn().mockResolvedValue({ allowed: true }) };
  const service = new LettersService(
    repo as never,
    { decide: vi.fn().mockResolvedValue({ decision: community, reasons: [] }) },
    {
      current: vi.fn().mockResolvedValue(ageBand === null ? null : { age_band: ageBand }),
    } as never,
    {
      isInteractionAllowed: vi
        .fn()
        .mockResolvedValue(
          allowed ? { allowed: true } : { allowed: false, reason: 'ACTIVE_BLOCK' },
        ),
    },
    { decide: vi.fn().mockResolvedValue({ decision: partitionDecision }) },
    rateLimiter,
  );
  return { service, repo, rateLimiter };
}

describe('LTR-01 LettersService policy gates', () => {
  it('uses the current ELG decision instead of a platform-wide adult literal', async () => {
    const youth = makeService('youth');
    await expect(
      youth.service.publish(OWNER, LETTER, 1, 'ltr-publish-youth-policy-0001'),
    ).resolves.toMatchObject({ state: 'published' });
    expect(youth.repo.publish).toHaveBeenCalled();
  });

  it('unverified_or_policy_denied_author_cannot_publish', async () => {
    const youth = makeService('youth', 'eligible', true, 'deny');
    await expect(
      youth.service.publish(OWNER, LETTER, 1, 'ltr-publish-youth-0001'),
    ).rejects.toMatchObject({ status: 403 });
    expect(youth.repo.publish).not.toHaveBeenCalled();
    const unverified = makeService(null);
    await expect(
      unverified.service.publish(OWNER, LETTER, 1, 'ltr-publish-unknown-1'),
    ).rejects.toMatchObject({ status: 403 });
    expect(unverified.repo.publish).not.toHaveBeenCalled();
  });

  it('active_block_hides_published_letter_as_not_found', async () => {
    const blocked = makeService('adult', 'eligible', false);
    blocked.repo.getPublished.mockResolvedValue({ ownerId: OWNER, publication: { id: LETTER } });
    await expect(blocked.service.read(VIEWER, LETTER)).rejects.toMatchObject({ status: 404 });
  });

  it('lists_only_owner_bound_summaries', async () => {
    const service = makeService();
    service.repo.listOwned.mockResolvedValue({
      items: [
        {
          id: LETTER,
          kind: 'private_letter',
          state: 'draft',
          version: 1,
          revision: 1,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    await expect(service.service.list(OWNER, { limit: 20 })).resolves.toMatchObject({
      items: [{ id: LETTER }],
    });
    expect(service.repo.listOwned).toHaveBeenCalledWith(OWNER, { limit: 20 });
  });

  it('stale_or_current_policy_mismatch_hides_publication', async () => {
    const denied = makeService('adult', 'eligible', true, 'deny');
    denied.repo.getPublished.mockResolvedValue({ ownerId: OWNER, publication: { id: LETTER } });
    await expect(denied.service.read(VIEWER, LETTER)).rejects.toMatchObject({ status: 404 });
  });

  it('eligible_member_can_read_publication_after_owner_lookup_misses', async () => {
    const service = makeService();
    service.repo.getPublished.mockResolvedValue({
      ownerId: OWNER,
      publication: {
        id: LETTER,
        pen_name: 'Aurora',
        country_code: 'US',
        locale: 'en-US',
        topics: ['friendship'],
        content_reminder: 'none',
        revision: 1,
        title: 'Hello',
        body: { paragraphs: ['World'] },
      },
    });
    await expect(service.service.read(VIEWER, LETTER)).resolves.toMatchObject({ id: LETTER });
  });

  it('does_not_turn_public_letters_into_anonymous_internet_content', async () => {
    const limited = makeService('adult', 'limited');
    limited.repo.getPublished.mockResolvedValue({ ownerId: OWNER, publication: { id: LETTER } });
    await expect(limited.service.read(VIEWER, LETTER)).rejects.toMatchObject({ status: 404 });
  });

  it('stale_ineligible_owner_publication_is_hidden', async () => {
    const repo = {
      ...makeService().repo,
      getPublished: vi.fn().mockResolvedValue({ ownerId: OWNER, publication: { id: LETTER } }),
    };
    const community = {
      decide: vi.fn().mockImplementation(async (accountId: string) => ({
        decision: accountId === OWNER ? 'ineligible' : 'eligible',
        reasons: [],
      })),
    };
    const age = {
      current: vi.fn().mockImplementation(async (accountId: string) => ({
        age_band: accountId === OWNER ? 'youth' : 'adult',
      })),
    };
    const service = new LettersService(
      repo as never,
      community,
      age as never,
      { isInteractionAllowed: vi.fn().mockResolvedValue({ allowed: true }) },
      { decide: vi.fn().mockResolvedValue({ decision: 'allow' }) },
      { consume: vi.fn().mockResolvedValue({ allowed: true }) },
    );
    await expect(service.read(VIEWER, LETTER)).rejects.toMatchObject({ status: 404 });
  });

  it('owner_can_read_draft_without_exposing_it_to_other_accounts', async () => {
    const service = makeService();
    service.repo.getOwned.mockResolvedValue(record);
    const result = await service.service.read(OWNER, LETTER);
    expect(result).toMatchObject({ id: LETTER, state: 'draft' });
    service.repo.getOwned.mockResolvedValue(null);
    service.repo.getPublished.mockResolvedValue(null);
    await expect(service.service.read(VIEWER, LETTER)).rejects.toMatchObject({ status: 404 });
  });

  it('maps replay conflicts before policy or mutation and does not consume rate budget', async () => {
    const setup = makeService();
    setup.repo.replay.mockRejectedValue(new LetterIdempotencyConflictError());
    await expect(
      setup.service.publish(OWNER, LETTER, 1, 'ltr-publish-conflict-0001'),
    ).rejects.toMatchObject({ status: 409 });
    expect(setup.repo.publish).not.toHaveBeenCalled();
    expect(setup.rateLimiter.consume).not.toHaveBeenCalled();
  });

  it('returns a frozen publish replay before policy and rate checks', async () => {
    const setup = makeService();
    setup.repo.replay.mockResolvedValue({ ...record, state: 'published', version: 2 });
    await expect(
      setup.service.publish(OWNER, LETTER, 1, 'ltr-publish-replay-0001'),
    ).resolves.toMatchObject({ state: 'published', version: 2 });
    expect(setup.rateLimiter.consume).not.toHaveBeenCalled();
    expect(setup.repo.publish).not.toHaveBeenCalled();
  });

  it('returns stable 429 for a new mutation when the account budget is exhausted', async () => {
    const setup = makeService();
    setup.rateLimiter.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 10 });
    await expect(
      setup.service.create(
        OWNER,
        { ...record.content, kind: 'public_letter' },
        'ltr-create-rate-0001',
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(setup.repo.create).not.toHaveBeenCalled();
  });
});
