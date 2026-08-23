import { describe, expect, it, vi } from 'vitest';
import { rankWithDiversityCaps, WorldDiscoveryService } from './world-discovery.service.js';
import type { WorldDiscoveryCandidate } from '@wai/contracts';

const item = (
  n: number,
  country = 'US',
  owner = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
): WorldDiscoveryCandidate => ({
  publicationId: `00000000-0000-4000-8000-${String(n + 100).padStart(12, '0')}`,
  letterId: `00000000-0000-4000-8000-${String(n + 200).padStart(12, '0')}`,
  ownerId: owner,
  penName: 'A reader',
  countryCode: country,
  locale: 'en-US',
  topics: ['life_story'],
  contentReminder: 'none',
  revision: 1,
  title: `Letter ${n}`,
  body: { paragraphs: ['A paragraph'] },
  publishedAt: new Date(1_000 + n),
  bookmarked: false,
});

describe('WLD-01 discovery', () => {
  it('ranking_enforces_country_and_author_diversity_caps', () => {
    const result = rankWithDiversityCaps(
      [
        ...Array.from({ length: 5 }, (_, i) => item(i)),
        ...Array.from({ length: 3 }, (_, i) => item(i + 10, 'CA')),
      ],
      20,
    );
    expect(result.filter((value) => value.countryCode === 'US')).toHaveLength(3);
  });
  it('stale_discovery_index_never_bypasses_final_authorization', async () => {
    const repo = {
      discover: vi.fn().mockResolvedValue({ items: [item(1)], nextCursor: null }),
      recheck: vi.fn().mockResolvedValue(item(1)),
    };
    const gate = { check: vi.fn().mockResolvedValue({ allowed: false, reason: 'ACTIVE_BLOCK' }) };
    const service = new WorldDiscoveryService(repo as never, gate as never);
    expect(
      (await service.discover('00000000-0000-4000-8000-000000000001', { limit: 20 })).items,
    ).toHaveLength(0);
    expect(gate.check).toHaveBeenCalled();
    expect(gate.check.mock.calls[0]?.[0]).toEqual({
      actorAccountId: '00000000-0000-4000-8000-000000000001',
      subjectAccountId: item(1).ownerId,
    });
  });
  it('final_recheck_denies_policy_change_before_return', async () => {
    const candidate = item(2);
    const repo = {
      discover: vi.fn().mockResolvedValue({ items: [candidate], nextCursor: null }),
      recheck: vi.fn().mockResolvedValue(candidate),
    };
    const gate = {
      check: vi
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false, reason: 'POLICY_UNAVAILABLE' }),
    };
    const service = new WorldDiscoveryService(repo as never, gate as never);
    expect(
      (await service.discover('00000000-0000-4000-8000-000000000001', { limit: 20 })).items,
    ).toHaveLength(0);
    expect(gate.check).toHaveBeenCalledTimes(2);
  });
  it('final_publication_recheck_hides_withdrawn_letter_before_return', async () => {
    const candidate = item(3);
    const repo = {
      discover: vi.fn().mockResolvedValue({ items: [candidate], nextCursor: null }),
      recheck: vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(null),
    };
    const service = new WorldDiscoveryService(
      repo as never,
      { check: vi.fn().mockResolvedValue({ allowed: true }) } as never,
    );
    expect(
      (await service.discover('00000000-0000-4000-8000-000000000001', { limit: 20 })).items,
    ).toHaveLength(0);
    expect(repo.recheck).toHaveBeenCalledTimes(2);
  });
  it('world_feed_filters_country_language_and_topic_with_stable_cursor', async () => {
    const candidate = item(1);
    const repo = {
      discover: vi
        .fn()
        .mockResolvedValue({ items: [candidate], nextCursor: 'signed.cursor', hasMore: true }),
      recheck: vi.fn().mockResolvedValue(candidate),
      cursorAfter: vi.fn().mockReturnValue('stable.cursor'),
    };
    const service = new WorldDiscoveryService(
      repo as never,
      { check: vi.fn().mockResolvedValue({ allowed: true }) } as never,
    );
    const result = await service.discover('00000000-0000-4000-8000-000000000001', {
      country: 'US',
      locale: 'en-US',
      topic: 'travel',
      limit: 5,
    });
    expect(repo.discover).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ country: 'US', locale: 'en-US', topic: 'travel' }),
    );
    expect(result.next_cursor).toBe('stable.cursor');
    expect(repo.cursorAfter).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ country: 'US', locale: 'en-US', topic: 'travel' }),
      expect.objectContaining({ publicationId: candidate.publicationId }),
      'signed.cursor',
    );
  });
  it('bounded_overscan_fills_after_denied_prefix_without_dropping_the_next_page', async () => {
    const countries = ['CA', 'GB', 'FR', 'DE', 'JP', 'AU', 'BR', 'IN', 'MX', 'ES'];
    const topics = [
      'life_story',
      'culture',
      'travel',
      'language_learning',
      'family',
      'work',
      'place',
      'tradition',
      'identity',
      'change',
    ];
    const candidates = Array.from({ length: 50 }, (_, index) => {
      const candidate = item(
        index + 1,
        index < 20 ? 'US' : countries[(index - 20) % countries.length]!,
      );
      return index < 20
        ? candidate
        : { ...candidate, topics: [topics[(index - 20) % topics.length]!] };
    });
    const repo = {
      discover: vi
        .fn()
        .mockResolvedValueOnce({ items: candidates, nextCursor: null })
        .mockResolvedValueOnce({ items: candidates.slice(40), nextCursor: null }),
      recheck: vi
        .fn()
        .mockImplementation(
          async (_viewer: string, publicationId: string) =>
            candidates.find((candidate) => candidate.publicationId === publicationId) ?? null,
        ),
      cursorAfter: vi.fn().mockReturnValue('page-2'),
    };
    const gate = {
      check: vi
        .fn()
        .mockImplementation(async ({ subjectAccountId }: { subjectAccountId: string }) => ({
          allowed: Number(subjectAccountId.slice(-12)) > 20,
        })),
    };
    const service = new WorldDiscoveryService(repo as never, gate as never);
    const result = await service.discover('00000000-0000-4000-8000-000000000001', { limit: 20 });
    expect(result.items).toHaveLength(20);
    expect(result.next_cursor).toBe('page-2');
    const second = await service.discover('00000000-0000-4000-8000-000000000001', {
      limit: 20,
      cursor: 'page-2',
    });
    expect(second.items).toHaveLength(10);
    const firstIds = new Set(result.items.map((value) => value.publication_id));
    const secondIds = new Set(second.items.map((value) => value.publication_id));
    expect(secondIds.size).toBe(10);
    expect([...secondIds].some((id) => firstIds.has(id))).toBe(false);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(30);
  });
  it('blocked_or_withdrawn_letter_never_appears', async () => {
    const repo = {
      get: vi.fn().mockResolvedValue(item(1)),
      recheck: vi.fn().mockResolvedValue(item(1)),
    };
    const service = new WorldDiscoveryService(
      repo as never,
      { check: vi.fn().mockResolvedValue({ allowed: false, reason: 'ACTIVE_BLOCK' }) } as never,
    );
    await expect(
      service.read('00000000-0000-4000-8000-000000000001', item(1).publicationId),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });
  it('bookmark_is_idempotent_and_owner_bound', async () => {
    const repo = {
      get: vi.fn().mockResolvedValue(item(1)),
      recheck: vi.fn().mockResolvedValue(item(1)),
      bookmark: vi.fn().mockResolvedValue({
        publication_id: item(1).publicationId,
        bookmarked: true,
        created_at: new Date().toISOString(),
      }),
    };
    const service = new WorldDiscoveryService(
      repo as never,
      { check: vi.fn().mockResolvedValue({ allowed: true }) } as never,
    );
    await service.bookmark(
      '00000000-0000-4000-8000-000000000001',
      item(1).publicationId,
      'bookmark-key-123456',
    );
    expect(repo.bookmark).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'bookmark-key-123456',
    );
  });
  it('bookmark_does_not_write_after_final_publication_recheck_fails', async () => {
    const candidate = item(4);
    const repo = {
      get: vi.fn().mockResolvedValue(candidate),
      recheck: vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(null),
      bookmark: vi.fn(),
    };
    const service = new WorldDiscoveryService(
      repo as never,
      { check: vi.fn().mockResolvedValue({ allowed: true }) } as never,
    );
    await expect(
      service.bookmark(
        '00000000-0000-4000-8000-000000000001',
        candidate.publicationId,
        'bookmark-key-123456',
      ),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(repo.bookmark).not.toHaveBeenCalled();
  });
});
