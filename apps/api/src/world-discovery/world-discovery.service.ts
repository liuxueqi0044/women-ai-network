import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  bookmarkResponseSchema,
  type WorldDiscoveryCandidate,
  type WorldDiscoveryQuery,
} from '@wai/contracts';
import {
  WorldBookmarkIdempotencyConflictError,
  WorldCursorError,
  WorldPublicationNotFoundError,
} from '@wai/db';
import { WORLD_DISCOVERY_REPOSITORY } from './world-discovery.tokens.js';
import { WORLD_DISCOVERY_GATE } from './world-discovery-gate.token.js';
import type { WorldDiscoveryGateService } from './world-discovery-gate.service.js';
import type { WorldDiscoveryRepositoryPort } from '@wai/contracts';

const gateInput = (viewerId: string, ownerId: string) => ({
  actorAccountId: viewerId,
  subjectAccountId: ownerId,
});

@Injectable()
export class WorldDiscoveryService {
  constructor(
    @Inject(WORLD_DISCOVERY_REPOSITORY) private readonly repo: WorldDiscoveryRepositoryPort,
    @Inject(WORLD_DISCOVERY_GATE) private readonly gate: Pick<WorldDiscoveryGateService, 'check'>,
  ) {}

  async discover(viewerId: string, query: WorldDiscoveryQuery) {
    try {
      const candidates = await this.repo.discover(viewerId, query);
      const visible: WorldDiscoveryCandidate[] = [];
      let scanned = 0;
      for (const candidate of candidates.items) {
        scanned += 1;
        if (!(await this.allowed(viewerId, candidate.ownerId))) continue;
        const fresh = await this.repo.recheck(viewerId, candidate.publicationId);
        if (fresh === null || !(await this.allowed(viewerId, fresh.ownerId))) continue;
        const final = await this.repo.recheck(viewerId, fresh.publicationId);
        if (final !== null) visible.push(final);
        if (rankWithDiversityCaps(visible, query.limit).length >= query.limit) break;
      }
      const items = rankWithDiversityCaps(visible, query.limit).map(toResponse);
      const boundary = candidates.items[scanned - 1];
      const hasMore = scanned < candidates.items.length || candidates.hasMore;
      return {
        items,
        next_cursor:
          hasMore && boundary !== undefined
            ? this.repo.cursorAfter(
                viewerId,
                query,
                {
                  publicationId: boundary.publicationId,
                  publishedAt: boundary.publishedAt,
                },
                candidates.nextCursor,
              )
            : null,
      };
    } catch (error) {
      throw mapError(error);
    }
  }

  async read(viewerId: string, publicationId: string) {
    const candidate = await this.repo.get(viewerId, publicationId);
    if (candidate === null || !(await this.allowed(viewerId, candidate.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    const fresh = await this.repo.recheck(viewerId, publicationId);
    if (fresh === null || !(await this.allowed(viewerId, fresh.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    const final = await this.repo.recheck(viewerId, publicationId);
    if (final === null)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    return toResponse(final);
  }

  async bookmark(viewerId: string, publicationId: string, idempotencyKey: string) {
    const candidate = await this.repo.get(viewerId, publicationId);
    if (candidate === null || !(await this.allowed(viewerId, candidate.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    try {
      const fresh = await this.repo.recheck(viewerId, publicationId);
      if (fresh === null || !(await this.allowed(viewerId, fresh.ownerId)))
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
      if ((await this.repo.recheck(viewerId, publicationId)) === null)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
      return bookmarkResponseSchema.parse(
        await this.repo.bookmark(viewerId, publicationId, idempotencyKey),
      );
    } catch (error) {
      throw mapError(error);
    }
  }
  async unbookmark(viewerId: string, publicationId: string) {
    const candidate = await this.repo.get(viewerId, publicationId);
    if (candidate === null || !(await this.allowed(viewerId, candidate.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    const fresh = await this.repo.recheck(viewerId, publicationId);
    if (fresh === null || !(await this.allowed(viewerId, fresh.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    if ((await this.repo.recheck(viewerId, publicationId)) === null)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    await this.repo.unbookmark(viewerId, publicationId);
    return { publication_id: publicationId, bookmarked: false, created_at: null };
  }
  async bookmarkStatus(viewerId: string, publicationId: string) {
    const candidate = await this.repo.get(viewerId, publicationId);
    if (candidate === null || !(await this.allowed(viewerId, candidate.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    const fresh = await this.repo.recheck(viewerId, publicationId);
    if (fresh === null || !(await this.allowed(viewerId, fresh.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    if ((await this.repo.recheck(viewerId, publicationId)) === null)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    return {
      publication_id: publicationId,
      bookmarked: await this.repo.isBookmarked(viewerId, publicationId),
      created_at: null,
    };
  }
  async listBookmarks(viewerId: string, query: Pick<WorldDiscoveryQuery, 'cursor' | 'limit'>) {
    try {
      const result = await this.repo.listBookmarks(viewerId, query);
      const visible: WorldDiscoveryCandidate[] = [];
      let scanned = 0;
      for (const item of result.items) {
        scanned += 1;
        if (!(await this.allowed(viewerId, item.ownerId))) continue;
        const fresh = await this.repo.recheck(viewerId, item.publicationId);
        if (
          fresh !== null &&
          (await this.allowed(viewerId, fresh.ownerId)) &&
          (await this.repo.isBookmarked(viewerId, item.publicationId))
        ) {
          const final = await this.repo.recheck(viewerId, item.publicationId);
          if (final?.bookmarked === true) visible.push(final);
        }
        if (visible.length >= query.limit) break;
      }
      const boundary = result.items[scanned - 1];
      const hasMore = scanned < result.items.length || result.hasMore;
      return {
        items: visible.map(toResponse),
        next_cursor:
          hasMore && boundary !== undefined
            ? this.repo.cursorAfter(
                viewerId,
                { ...query },
                {
                  publicationId: boundary.publicationId,
                  bookmarkAt: boundary.bookmarkCreatedAt ?? boundary.publishedAt,
                },
                result.nextCursor,
              )
            : null,
      };
    } catch (error) {
      throw mapError(error);
    }
  }
  private async allowed(viewerId: string, ownerId: string) {
    try {
      return (await this.gate.check(gateInput(viewerId, ownerId))).allowed;
    } catch {
      return false;
    }
  }
}

export function rankWithDiversityCaps(
  items: readonly WorldDiscoveryCandidate[],
  limit: number,
): WorldDiscoveryCandidate[] {
  const countries = new Map<string, number>();
  const authors = new Map<string, number>();
  const topics = new Map<string, number>();
  const result: WorldDiscoveryCandidate[] = [];
  for (const item of items) {
    if (result.length >= limit) break;
    if ((countries.get(item.countryCode) ?? 0) >= 3 || (authors.get(item.ownerId) ?? 0) >= 2)
      continue;
    if (item.topics.some((topic) => (topics.get(topic) ?? 0) >= 3)) continue;
    result.push(item);
    countries.set(item.countryCode, (countries.get(item.countryCode) ?? 0) + 1);
    authors.set(item.ownerId, (authors.get(item.ownerId) ?? 0) + 1);
    for (const topic of item.topics) topics.set(topic, (topics.get(topic) ?? 0) + 1);
  }
  return result;
}
function toResponse(item: WorldDiscoveryCandidate) {
  return {
    publication_id: item.publicationId,
    letter_id: item.letterId,
    pen_name: item.penName,
    country_code: item.countryCode,
    locale: item.locale,
    topics: item.topics,
    content_reminder: item.contentReminder,
    revision: item.revision,
    title: item.title,
    body: item.body,
    published_at: item.publishedAt.toISOString(),
    bookmarked: item.bookmarked,
  };
}
function mapError(error: unknown): Error {
  if (error instanceof WorldCursorError)
    return new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Cursor is invalid' });
  if (error instanceof WorldBookmarkIdempotencyConflictError)
    return new ConflictException({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Idempotency key conflict',
    });
  if (error instanceof WorldPublicationNotFoundError)
    return new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
  return error instanceof Error ? error : new Error('world discovery failed');
}
