import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { letterContentSchema } from '@wai/contracts';
import type {
  CommunityAccessDecisionPort,
  LetterCreateRequest,
  LetterOwnerResponse,
  LetterPatchRequest,
  LetterPublication,
  LetterRecord,
  LetterRepositoryPort,
  SafetyBlockDecisionPort,
} from '@wai/contracts';
import {
  LetterConcurrencyError,
  LetterIdempotencyConflictError,
  LetterNotFoundError,
  LetterStateError,
} from '@wai/db';
import { AgeCredentialService } from '../eligibility/services/age-credential.service.js';
import { PartitionDecisionService } from '../eligibility/services/partition-decision.service.js';
import { COMMUNITY_ACCESS_DECISION_PORT } from '../verification/verification.tokens.js';
import { SAFETY_BLOCK_DECISION } from '../safety/tokens.js';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
import { rateLimited } from '../account/services/registration.service.js';
import { LETTER_REPOSITORY } from './letters.tokens.js';

@Injectable()
export class LettersService {
  constructor(
    @Inject(LETTER_REPOSITORY) private readonly repo: LetterRepositoryPort,
    @Inject(COMMUNITY_ACCESS_DECISION_PORT)
    private readonly community: CommunityAccessDecisionPort,
    @Inject(AgeCredentialService) private readonly age: AgeCredentialService,
    @Inject(SAFETY_BLOCK_DECISION) private readonly safety: SafetyBlockDecisionPort,
    @Inject(PartitionDecisionService)
    private readonly partition: Pick<PartitionDecisionService, 'decide'>,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  async create(accountId: string, input: LetterCreateRequest, idempotencyKey: string) {
    const normalized = inputToCreate(input);
    const replay = await this.replay({
      ownerId: accountId,
      idempotencyKey,
      payload: { kind: normalized.kind, content: normalized.content },
    });
    if (replay !== null) return toOwnerResponse(replay);
    await this.consumeMutationLimit(accountId, 'create');
    try {
      return toOwnerResponse(
        await this.repo.create({ ownerId: accountId, ...normalized, idempotencyKey }),
      );
    } catch (error) {
      throw mapLetterError(error);
    }
  }

  async autosave(
    accountId: string,
    letterId: string,
    input: LetterPatchRequest,
    expectedVersion: number,
    idempotencyKey: string,
  ) {
    const replay = await this.replay({
      ownerId: accountId,
      idempotencyKey,
      payload: { letter_id: letterId, expected_version: expectedVersion, content: input },
    });
    if (replay !== null) return toOwnerResponse(replay);
    await this.consumeMutationLimit(accountId, 'autosave');
    try {
      return toOwnerResponse(
        await this.repo.autosave({
          ownerId: accountId,
          letterId,
          content: input,
          expectedVersion,
          idempotencyKey,
        }),
      );
    } catch (error) {
      throw mapLetterError(error);
    }
  }

  async read(
    accountId: string,
    letterId: string,
  ): Promise<LetterOwnerResponse | LetterPublication> {
    const owned = await this.repo.getOwned(accountId, letterId);
    if (owned !== null) return toOwnerResponse(owned);
    const published = await this.repo.getPublished(letterId);
    if (published === null || !(await this.canReadPublished(accountId, published.ownerId)))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    return published.publication;
  }

  /** Controlled publication-bound source port for derived translation work. */
  async readPublishedSource(viewerId: string, letterId: string) {
    const published = await this.repo.getPublished(letterId);
    if (published === null || !(await this.canReadPublished(viewerId, published.ownerId)))
      return null;
    const snapshot = await this.repo.readPublishedRevision(letterId);
    if (
      snapshot === null ||
      snapshot.ownerId !== published.ownerId ||
      snapshot.revisionId !== published.source.revisionId ||
      snapshot.sourceHash !== published.source.sourceHash ||
      snapshot.state !== 'published' ||
      snapshot.currentRevision !== snapshot.revision
    )
      return null;
    return snapshot;
  }

  /** Controlled owner-bound source port; callers must already be the owner. */
  async readPrivateSource(ownerId: string, letterId: string, revision?: number) {
    const owned = await this.repo.getOwned(ownerId, letterId);
    if (owned === null || owned.kind !== 'private_letter') return null;
    const snapshot = await this.repo.readOwnedRevision(
      ownerId,
      letterId,
      revision ?? owned.revision,
    );
    if (
      snapshot === null ||
      snapshot.ownerId !== ownerId ||
      snapshot.letterId !== letterId ||
      snapshot.kind !== 'private_letter'
    )
      return null;
    return snapshot;
  }

  async list(accountId: string, query: { cursor?: string; limit: number }) {
    try {
      const result = await this.repo.listOwned(accountId, query);
      return { items: result.items, next_cursor: result.nextCursor };
    } catch (error) {
      if (error instanceof Error && error.message === 'letter_cursor_invalid') {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Cursor is invalid' });
      }
      throw mapLetterError(error);
    }
  }

  async publish(
    accountId: string,
    letterId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ) {
    const replay = await this.replay({
      ownerId: accountId,
      idempotencyKey,
      payload: { letter_id: letterId, expected_version: expectedVersion, action: 'publish' },
    });
    if (replay !== null) return toOwnerResponse(replay);
    if (!(await this.canPublish(accountId)))
      throw new ForbiddenException({
        code: 'LETTER_POLICY_DENIED',
        message: 'Letter publication is not available',
      });
    await this.consumeMutationLimit(accountId, 'publish');
    try {
      return toOwnerResponse(
        await this.repo.publish({ ownerId: accountId, letterId, expectedVersion, idempotencyKey }),
      );
    } catch (error) {
      throw mapLetterError(error);
    }
  }

  private async consumeMutationLimit(
    accountId: string,
    operation: 'create' | 'autosave' | 'publish',
  ): Promise<void> {
    const limits = { create: 20, autosave: 120, publish: 10 } as const;
    try {
      const result = await this.rateLimiter.consume(
        `letters:${operation}:${accountId}`,
        limits[operation],
        60,
      );
      if (!result.allowed) throw rateLimited(result.retryAfterSeconds);
    } catch (error) {
      if (error instanceof Error && 'status' in error) throw error;
      throw rateLimited(undefined);
    }
  }

  private async replay(input: {
    ownerId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<LetterRecord | null> {
    try {
      return await this.repo.replay(input);
    } catch (error) {
      throw mapLetterError(error);
    }
  }

  async withdraw(
    accountId: string,
    letterId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ) {
    try {
      return toOwnerResponse(
        await this.repo.withdraw({ ownerId: accountId, letterId, expectedVersion, idempotencyKey }),
      );
    } catch (error) {
      throw mapLetterError(error);
    }
  }

  async archive(
    accountId: string,
    letterId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ) {
    try {
      return toOwnerResponse(
        await this.repo.archive({ ownerId: accountId, letterId, expectedVersion, idempotencyKey }),
      );
    } catch (error) {
      throw mapLetterError(error);
    }
  }

  private async canPublish(accountId: string): Promise<boolean> {
    try {
      const access = await this.community.decide(accountId, 'letter_publish');
      const credential = await this.age.current(accountId);
      const block = await this.safety.isInteractionAllowed(accountId, accountId, 'profile');
      const partition = await this.partition.decide(accountId, accountId, {
        capability: 'discover',
      });
      return (
        access.decision === 'eligible' &&
        credential !== null &&
        block.allowed &&
        partition.decision === 'allow'
      );
    } catch {
      return false;
    }
  }

  private async canReadPublished(viewerId: string, ownerId: string): Promise<boolean> {
    try {
      const [access, credential, block, ownerAccess, ownerCredential, partition] =
        await Promise.all([
          this.community.decide(viewerId, 'letter_read'),
          this.age.current(viewerId),
          this.safety.isInteractionAllowed(viewerId, ownerId, 'profile'),
          this.community.decide(ownerId, 'letter_read'),
          this.age.current(ownerId),
          this.partition.decide(viewerId, ownerId, { capability: 'discover' }),
        ]);
      return (
        access.decision === 'eligible' &&
        credential !== null &&
        ownerAccess.decision === 'eligible' &&
        ownerCredential !== null &&
        block.allowed &&
        partition.decision === 'allow'
      );
    } catch {
      return false;
    }
  }
}

function inputToCreate(input: LetterCreateRequest) {
  const { kind, ...content } = input;
  return { kind, content: letterContentSchema.parse(content) };
}

function toOwnerResponse(record: LetterRecord): LetterOwnerResponse {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    version: record.version,
    title: record.content.title,
    body: record.content.body,
    locale: record.content.locale,
    country_code: record.content.country_code,
    topics: record.content.topics,
    content_reminder: record.content.content_reminder,
    pen_name: record.content.pen_name,
    revision: record.revision,
    updated_at: record.updatedAt.toISOString(),
  };
}

function mapLetterError(error: unknown): Error {
  if (error instanceof LetterNotFoundError)
    return new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
  if (error instanceof LetterIdempotencyConflictError)
    return new ConflictException({ code: 'LETTER_CONFLICT', message: 'Idempotency key conflict' });
  if (error instanceof LetterConcurrencyError)
    return new ConflictException({ code: 'LETTER_CONFLICT', message: 'Letter version conflict' });
  if (error instanceof LetterStateError)
    return new ConflictException({
      code: 'LETTER_STATE_INVALID',
      message: 'Letter state does not allow this operation',
    });
  return error instanceof Error ? error : new Error('letter operation failed');
}
