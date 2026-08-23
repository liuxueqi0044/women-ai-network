import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  canonicalJsonHash,
  IntroductionDecisionConflictError,
  IntroductionIdempotencyConflictError,
} from '@wai/db';
import {
  introductionDecisionRequestSchema,
  introductionExplanationResponseSchema,
  introductionHistoryQuerySchema,
  introductionListQuerySchema,
  introductionListResponseSchema,
  introductionDecisionResponseSchema,
  type IntroductionExplanationPort,
  type IntroductionPolicyGate,
  type IntroductionRepositoryPort,
} from '@wai/contracts';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
import { rateLimited } from '../account/services/registration.service.js';
import { INTRODUCTION_GATE, INTRODUCTION_REPOSITORY } from './introductions.tokens.js';

const reasonText: Record<string, string> = {
  PREFERENCES_ALIGN: 'Your current preferences are compatible.',
  SHARED_INTEREST: 'You both listed a shared interest.',
  COMMUNICATION_FIT: 'Your communication preferences are compatible.',
  PACE_ALIGNMENT: 'Your preferred conversation pace is aligned.',
  AVAILABILITY_ALIGNMENT: 'Your availability preferences are aligned.',
  LANGUAGE_ALIGNMENT: 'You both selected a compatible language.',
  GEOGRAPHY_ALIGNMENT: 'You both selected a compatible geography.',
  VALUES_ALIGNMENT: 'You both listed compatible values.',
};
const localExplanation: IntroductionExplanationPort = {
  async render(input) {
    return input.reasons
      .map((reason) => reasonText[reason] ?? '')
      .filter(Boolean)
      .join(' ');
  },
};

@Injectable()
export class IntroductionsService {
  private readonly renderer: IntroductionExplanationPort = localExplanation;
  constructor(
    @Inject(INTRODUCTION_REPOSITORY) private readonly repo: IntroductionRepositoryPort,
    @Inject(INTRODUCTION_GATE) private readonly gate: IntroductionPolicyGate,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}
  async list(accountId: string, body: unknown) {
    const rate = await this.rateLimiter.consume(`introductions:list:${accountId}`, 30, 60);
    if (!rate.allowed) throw rateLimited(rate.retryAfterSeconds);
    const input = introductionListQuerySchema.parse(body);
    let batch = await this.repo.currentBatch(accountId, input.mode);
    if (!batch)
      batch = await this.repo.createBatch({ accountId, mode: input.mode, limit: input.limit });
    let page;
    try {
      page = await this.repo.listCandidates({
        accountId,
        batchId: batch.id,
        mode: input.mode,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_CURSOR')
        throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Invalid cursor' });
      throw error;
    }
    const candidates = [];
    for (const row of page.rows) {
      const final = await this.gate.check({
        actorAccountId: accountId,
        subjectAccountId: row.subjectAccountId,
        mode: row.mode,
        allowExistingMutual: row.outcome === 'mutual',
      });
      if (!final.allowed) continue;
      if (!row.subjectCard) continue;
      candidates.push({
        id: row.id,
        mode: row.mode,
        subject: { display_name: row.subjectCard.displayName },
        reasons: row.reasons,
        explanation: await this.renderer.render({
          mode: row.mode,
          reasons: row.reasons,
          visibleFacts: row.visibleFacts,
        }),
        decision: row.decision,
        outcome: row.outcome,
      });
    }
    return introductionListResponseSchema.parse({
      batch_id: batch.id,
      mode: input.mode,
      candidates,
      next_cursor: page.nextCursor,
      refresh_after: batch.refreshAfter.toISOString(),
    });
  }
  async decide(accountId: string, introductionId: string, body: unknown, key: string) {
    const rate = await this.rateLimiter.consume(`introductions:decision:${accountId}`, 20, 60);
    if (!rate.allowed) throw rateLimited(rate.retryAfterSeconds);
    const input = introductionDecisionRequestSchema.parse(body);
    const row = await this.repo.findCandidate(accountId, introductionId);
    if (!row || row.batchId !== input.batch_id)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Introduction not found' });
    const payloadDigest = canonicalJsonHash({
      actor_account_id: accountId,
      introduction_id: introductionId,
      batch_id: input.batch_id,
      decision: input.decision,
      request: input,
    });
    const recovery =
      row.outcome === null && input.decision === 'interested'
        ? await this.repo.canRecoverMutual({
            actorAccountId: accountId,
            introductionId,
            idempotencyKey: key,
            payloadDigest,
          })
        : false;
    const allowed = await this.gate.check({
      actorAccountId: accountId,
      subjectAccountId: row.subjectAccountId,
      mode: row.mode,
      allowExistingMutual: row.outcome === 'mutual' || recovery,
    });
    if (!allowed.allowed)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Introduction not found' });
    const actorProof = canonicalJsonHash({
      accountId,
      introductionId,
      decision: input.decision,
      batchId: input.batch_id,
    });
    try {
      const result = await this.repo.decide({
        actorAccountId: accountId,
        introductionId,
        batchId: input.batch_id,
        decision: input.decision,
        idempotencyKey: key,
        payloadDigest,
        actorProof,
      });
      const final = await this.gate.check({
        actorAccountId: accountId,
        subjectAccountId: row.subjectAccountId,
        mode: row.mode,
        allowExistingMutual: result.outcome === 'mutual' || recovery,
      });
      if (!final.allowed)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Introduction not found' });
      return introductionDecisionResponseSchema.parse({
        introduction_id: introductionId,
        batch_id: input.batch_id,
        decision: input.decision,
        outcome: result.outcome,
      });
    } catch (error) {
      if (error instanceof IntroductionIdempotencyConflictError)
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Decision payload conflict',
        });
      if (error instanceof IntroductionDecisionConflictError)
        throw new ConflictException({
          code: 'DECISION_IMMUTABLE',
          message: 'Decision cannot change',
        });
      if (error instanceof Error && error.message === 'INTRODUCTION_GATE_DENIED')
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Introduction not found' });
      throw error;
    }
  }
  async history(accountId: string, query: unknown) {
    const input = introductionHistoryQuerySchema.parse(query);
    try {
      const page = await this.repo.history({
        accountId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const visible = [];
      for (const item of page.items) {
        const row = await this.repo.findCandidate(accountId, item.id);
        if (!row) continue;
        const final = await this.gate.check({
          actorAccountId: accountId,
          subjectAccountId: row.subjectAccountId,
          mode: row.mode,
          allowExistingMutual: row.outcome === 'mutual',
        });
        if (final.allowed) visible.push(item);
      }
      return { ...page, items: visible };
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_CURSOR')
        throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Invalid cursor' });
      throw error;
    }
  }
  async explanation(accountId: string, id: string) {
    const row = await this.repo.findCandidate(accountId, id);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Introduction not found' });
    const allowed = await this.gate.check({
      actorAccountId: accountId,
      subjectAccountId: row.subjectAccountId,
      mode: row.mode,
      allowExistingMutual: row.outcome === 'mutual',
    });
    if (!allowed.allowed)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Introduction not found' });
    return introductionExplanationResponseSchema.parse({
      introduction_id: row.id,
      mode: row.mode,
      reasons: row.reasons,
      explanation: await this.renderer.render({
        mode: row.mode,
        reasons: row.reasons,
        visibleFacts: row.visibleFacts,
      }),
    });
  }
}
