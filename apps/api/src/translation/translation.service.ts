import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hmacDigest, parsePepper, TranslationIdempotencyConflictError } from '@wai/db';
import {
  translationCacheKeySchema,
  translationConsentRequestSchema,
  translationRequestSchema,
  translationConsentSchema,
  type TranslationProvider,
  type TranslationRepositoryPort,
  type TranslationSourcePort,
  type TranslationTask,
  type TranslationFallbackResponse,
} from '@wai/contracts';
import type { AppConfig } from '@wai/config';
import { JOB_NAMES } from '@wai/contracts';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
import { APP_CONFIG, TRANSLATION_QUEUE_ADAPTER } from '../tokens.js';
import type { QueueProducerAdapter } from '../infra/adapters.js';
import {
  TRANSLATION_PROVIDERS,
  TRANSLATION_REPOSITORY,
  TRANSLATION_SOURCE,
} from './translation.tokens.js';

@Injectable()
export class TranslationService {
  private readonly digestKey: Buffer;

  constructor(
    @Inject(TRANSLATION_REPOSITORY) private readonly repo: TranslationRepositoryPort,
    @Inject(TRANSLATION_SOURCE) private readonly source: TranslationSourcePort,
    @Inject(TRANSLATION_PROVIDERS)
    private readonly providers: ReadonlyMap<string, TranslationProvider>,
    @Inject(TRANSLATION_QUEUE_ADAPTER) private readonly queue: QueueProducerAdapter,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.digestKey = parsePepper(config.iam.secretPepper);
  }

  async request(ownerId: string, raw: unknown, idempotencyKey: string) {
    const request = translationRequestSchema.parse(raw);
    const requestDigest = this.digest('request', JSON.stringify(request));
    let replayFallback: TranslationFallbackResponse | null = null;
    try {
      const replay = await this.repo.replay({ ownerId, requestDigest, idempotencyKey });
      if (replay !== null) {
        if ('fallback' in replay) replayFallback = replay.fallback;
        else {
          await this.authorizeTaskReplay(ownerId, replay.task);
          if (replay.task.state === 'queued' || replay.task.state === 'retry_wait')
            await this.enqueue(replay.task);
          return taskResponse(replay.task);
        }
      }
    } catch (error) {
      throw mapTranslationError(error);
    }

    const source = await this.readSource(ownerId, request.letter_id);
    if (source === null)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    if (replayFallback !== null) return replayFallback;
    if (source.content.locale === request.target_locale)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Target locale must differ from source',
      });

    const provider =
      request.provider_id === undefined ? undefined : this.providers.get(request.provider_id);
    if (provider === undefined) {
      if (request.provider_id !== undefined)
        throw new ForbiddenException({
          code: 'TRANSLATION_PROVIDER_UNAVAILABLE',
          message: 'Translation provider unavailable',
        });
      const fallback = {
        machine_translated: false as const,
        source_locale: source.content.locale,
        target_locale: request.target_locale,
        original: { title: source.content.title, body: source.content.body },
      };
      try {
        return await this.repo.saveFallbackReplay({
          ownerId,
          requestDigest,
          idempotencyKey,
          fallback,
        });
      } catch (error) {
        throw mapTranslationError(error);
      }
    }
    if (source.kind === 'private_letter' && !provider.capability.supports_private)
      throw new ForbiddenException({
        code: 'TRANSLATION_CONSENT_REQUIRED',
        message: 'Private translation is unavailable',
      });
    let consent: Awaited<ReturnType<TranslationRepositoryPort['currentConsent']>> = null;
    if (source.kind === 'private_letter') {
      consent = await this.findConsent(ownerId, source, provider);
      if (
        consent === null ||
        !consent.no_training ||
        !provider.capability.processing_regions.includes(consent.processing_region) ||
        consent.provider_version !== provider.capability.provider_version ||
        consent.retention_policy !== provider.capability.retention_policy ||
        consent.retention_seconds !== provider.capability.retention_seconds
      )
        throw new ForbiddenException({
          code: 'TRANSLATION_CONSENT_REQUIRED',
          message: 'Private translation consent is required',
        });
    }
    await this.limit(ownerId, source.letterId, request.target_locale);
    const key = translationCacheKeySchema.parse({
      source_kind: source.kind,
      letter_id: source.letterId,
      source_revision_id: source.revisionId,
      source_revision: source.revision,
      source_hash: source.sourceHash,
      source_locale: source.content.locale,
      target_locale: request.target_locale,
      provider_id: provider.capability.provider_id,
      provider_version: provider.capability.provider_version,
    });
    try {
      const result = await this.repo.createOrReplay({
        ownerId,
        key,
        requestDigest,
        idempotencyKey,
        ...(consent === null
          ? {}
          : {
              consent: {
                id: consent.id,
                providerVersion: consent.provider_version,
                processingRegion: consent.processing_region,
                retentionPolicy: consent.retention_policy,
                retentionSeconds: consent.retention_seconds,
              },
            }),
      });
      if (result.created || result.task.state === 'queued' || result.task.state === 'retry_wait')
        await this.enqueue(result.task);
      return taskResponse(result.task);
    } catch (error) {
      throw mapTranslationError(error);
    }
  }

  async read(ownerId: string, letterId: string, targetLocale: string, providerId?: string) {
    const source = await this.readSource(ownerId, letterId);
    if (source === null)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Translation not found' });
    const task = await this.repo.findLatest(
      source.kind === 'public_letter'
        ? providerId === undefined
          ? { letterId, targetLocale }
          : { letterId, targetLocale, providerId }
        : providerId === undefined
          ? { ownerId, letterId, targetLocale }
          : { ownerId, letterId, targetLocale, providerId },
    );
    if (task === null || !sameSource(task, source))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Translation not found' });
    await this.authorizeTaskReplay(ownerId, task);
    const result = task.state === 'ready' ? await this.repo.read({ taskId: task.id }) : null;
    return {
      task_id: task.id,
      state: task.state,
      source_locale: source.content.locale,
      target_locale: targetLocale,
      machine_translated: true as const,
      result:
        result === null
          ? null
          : {
              task_id: result.taskId,
              schema_version: 1 as const,
              source_locale: result.sourceLocale,
              target_locale: result.targetLocale,
              provider_id: result.providerId,
              provider_version: result.providerVersion,
              title: result.title,
              body: result.body,
              created_at: result.createdAt.toISOString(),
            },
    };
  }

  async grantConsent(ownerId: string, letterId: string, raw: unknown) {
    const request = translationConsentRequestSchema.parse(raw);
    const source = await this.source.readPrivateSource(ownerId, letterId);
    if (source === null)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Letter not found' });
    const provider = this.providers.get(request.provider_id);
    if (
      provider === undefined ||
      !provider.capability.supports_private ||
      !provider.capability.no_training ||
      provider.capability.provider_version !== request.provider_version ||
      provider.capability.retention_policy !== request.retention_policy ||
      provider.capability.retention_seconds !== request.retention_seconds ||
      !provider.capability.processing_regions.includes(request.processing_region)
    )
      throw new ForbiddenException({
        code: 'TRANSLATION_PROVIDER_UNAVAILABLE',
        message: 'Provider policy is unavailable',
      });
    const expiresAt = new Date(request.expires_at);
    if (expiresAt <= new Date())
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Consent expiry is invalid',
      });
    const consent = await this.repo.saveConsent({
      id: randomUUID(),
      owner_id: ownerId,
      source_kind: 'private_letter',
      letter_id: letterId,
      source_revision_id: source.revisionId,
      source_hash: source.sourceHash,
      provider_id: provider.capability.provider_id,
      provider_version: provider.capability.provider_version,
      processing_region: request.processing_region,
      retention_policy: request.retention_policy,
      retention_seconds: request.retention_seconds,
      capability: 'private_translation',
      no_training: true,
      expires_at: expiresAt.toISOString(),
      revoked_at: null,
      created_at: new Date().toISOString(),
    });
    return translationConsentSchema.parse(consent);
  }

  async revokeConsent(ownerId: string, consentId: string) {
    const ok = await this.repo.revokeConsent({ ownerId, consentId, now: new Date() });
    if (!ok) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Consent not found' });
    return { revoked: true };
  }

  private async readSource(ownerId: string, letterId: string) {
    return (
      (await this.source.readPublicSource(ownerId, letterId)) ??
      (await this.source.readPrivateSource(ownerId, letterId))
    );
  }

  private async limit(ownerId: string, letterId: string, locale: string) {
    const outcome = await this.rateLimiter.consume(
      `translation:${ownerId}:${letterId}:${locale}`,
      30,
      60,
    );
    if (!outcome.allowed)
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Translation rate limit exceeded',
        },
        429,
      );
  }

  private async enqueue(task: TranslationTask) {
    await this.queue.enqueue(
      JOB_NAMES.translationProcess,
      { task_id: task.id },
      {
        jobId: task.id,
        attempts: 1,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    // The PostgreSQL wake intent remains the recovery path if this process
    // dies before the queue call, or if the queue accepted the job but this
    // acknowledgement cannot be persisted. A failed acknowledgement is safe:
    // the reconciler will enqueue the deterministic wake again.
    try {
      await this.repo.markWakeupEnqueued({
        taskId: task.id,
        attempt: task.attempts,
        enqueuedAt: new Date(),
      });
    } catch {
      // Do not turn a successfully persisted task into an API error.
    }
  }

  private async authorizeTaskReplay(ownerId: string, task: TranslationTask): Promise<void> {
    const source = await this.readSource(ownerId, task.key.letter_id);
    if (source === null || !sameSource(task, source))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Translation not found' });
    const provider = this.providers.get(task.key.provider_id);
    if (
      provider === undefined ||
      provider.capability.provider_version !== task.key.provider_version
    )
      throw new ForbiddenException({
        code: 'TRANSLATION_PROVIDER_UNAVAILABLE',
        message: 'Translation provider unavailable',
      });
    if (source.kind === 'private_letter') {
      const binding = task.consentBinding;
      if (binding === undefined)
        throw new ForbiddenException({
          code: 'TRANSLATION_CONSENT_REQUIRED',
          message: 'Private translation consent is required',
        });
      const consent = await this.repo.currentConsent({
        ownerId,
        letterId: source.letterId,
        sourceRevisionId: source.revisionId,
        sourceHash: source.sourceHash,
        providerId: provider.capability.provider_id,
        providerVersion: binding.providerVersion,
        processingRegion: binding.processingRegion,
        retentionPolicy: binding.retentionPolicy,
        retentionSeconds: binding.retentionSeconds,
        now: new Date(),
      });
      if (consent === null || consent.id !== binding.id)
        throw new ForbiddenException({
          code: 'TRANSLATION_CONSENT_REQUIRED',
          message: 'Private translation consent is required',
        });
    }
  }

  private async findConsent(
    ownerId: string,
    source: { letterId: string; revisionId: string; sourceHash: string },
    provider: TranslationProvider,
  ) {
    for (const processingRegion of provider.capability.processing_regions) {
      const consent = await this.repo.currentConsent({
        ownerId,
        letterId: source.letterId,
        sourceRevisionId: source.revisionId,
        sourceHash: source.sourceHash,
        providerId: provider.capability.provider_id,
        providerVersion: provider.capability.provider_version,
        processingRegion,
        retentionPolicy: provider.capability.retention_policy,
        retentionSeconds: provider.capability.retention_seconds,
        now: new Date(),
      });
      if (consent !== null) return consent;
    }
    return null;
  }

  private digest(context: string, value: string) {
    return hmacDigest(this.digestKey, `translation:${context}`, value);
  }
}

function sameSource(
  task: TranslationTask,
  source: {
    revisionId: string;
    revision: number;
    sourceHash: string;
    letterId: string;
    kind: string;
  },
) {
  return (
    task.key.letter_id === source.letterId &&
    task.key.source_kind === source.kind &&
    task.key.source_revision_id === source.revisionId &&
    task.key.source_revision === source.revision &&
    task.key.source_hash === source.sourceHash
  );
}

function taskResponse(task: TranslationTask) {
  return {
    task_id: task.id,
    state: task.state,
    source_locale: task.key.source_locale,
    target_locale: task.key.target_locale,
    machine_translated: true as const,
    result: null,
  };
}

function mapTranslationError(error: unknown): Error {
  if (error instanceof TranslationIdempotencyConflictError)
    return new ConflictException({
      code: 'TRANSLATION_IDEMPOTENCY_CONFLICT',
      message: 'Idempotency key conflict',
    });
  return error instanceof Error ? error : new Error('translation operation failed');
}
