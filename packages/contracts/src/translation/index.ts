import { z } from 'zod';
import { idSchema } from '../ids.js';
import {
  bcp47LocaleSchema,
  type LetterBody,
  type LetterContent,
  type LetterRevisionSnapshot,
  type PublishedLetterRevisionSnapshot,
} from '../letters/index.js';

export const translationSourceKindSchema = z.enum(['public_letter', 'private_letter']);
export type TranslationSourceKind = z.infer<typeof translationSourceKindSchema>;
export const translationStateSchema = z.enum([
  'queued',
  'leased',
  'retry_wait',
  'ready',
  'failed',
  'cancelled',
]);
export type TranslationState = z.infer<typeof translationStateSchema>;
export const translationWakeupSchema = z.object({ task_id: idSchema }).strict();

const providerIdentifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'provider identifier is invalid');
const providerVersionSchema = z.string().trim().min(1).max(128);
const sourceHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const translationCacheKeySchema = z
  .object({
    source_kind: translationSourceKindSchema,
    letter_id: idSchema,
    source_revision_id: idSchema,
    source_revision: z.number().int().positive(),
    source_hash: sourceHashSchema,
    source_locale: bcp47LocaleSchema,
    target_locale: bcp47LocaleSchema,
    provider_id: providerIdentifierSchema,
    provider_version: providerVersionSchema,
  })
  .strict()
  .refine((value) => value.source_locale !== value.target_locale, {
    message: 'target locale must differ from source locale',
  });
export type TranslationCacheKey = z.infer<typeof translationCacheKeySchema>;

export const translationRequestSchema = z
  .object({
    letter_id: idSchema,
    target_locale: bcp47LocaleSchema,
    provider_id: providerIdentifierSchema.optional(),
  })
  .strict();
export type TranslationRequest = z.infer<typeof translationRequestSchema>;
export const translationRequestBodySchema = z
  .object({ target_locale: bcp47LocaleSchema, provider_id: providerIdentifierSchema.optional() })
  .strict();

const noMarkup = (value: string): boolean =>
  !/[<>]/.test(value) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
const noInstructionEnvelope = (value: string): boolean =>
  !/\b(ignore|disregard)\s+(previous|earlier|system)\b/i.test(value) &&
  !/\b(tool|function)\s*call\b/i.test(value);
const translatedTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(noMarkup, 'HTML and control characters are not accepted')
    .refine((value) => !/[\r\n]/.test(value), 'structured translation text cannot contain newlines')
    .refine(noInstructionEnvelope, 'instruction-like provider output is not accepted');

export const translationProviderOutputSchema = z
  .object({
    schema_version: z.literal(1),
    target_locale: bcp47LocaleSchema,
    title: translatedTextSchema(160),
    paragraphs: z.array(translatedTextSchema(2_000)).min(1).max(100),
  })
  .strict()
  .refine(
    (value) => value.paragraphs.reduce((total, paragraph) => total + paragraph.length, 0) <= 20_000,
    'translation output is too large',
  );
export type TranslationProviderOutput = z.infer<typeof translationProviderOutputSchema>;

export const translationProviderCapabilitySchema = z
  .object({
    provider_id: providerIdentifierSchema,
    provider_version: providerVersionSchema,
    processing_regions: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
    no_training: z.literal(true),
    retention_seconds: z.number().int().min(0).max(31_536_000),
    retention_policy: z.enum(['zero', 'ephemeral', 'bounded']),
    supports_private: z.boolean(),
  })
  .strict();
export type TranslationProviderCapability = z.infer<typeof translationProviderCapabilitySchema>;

export const translationConsentSchema = z
  .object({
    id: idSchema,
    owner_id: idSchema,
    source_kind: z.literal('private_letter'),
    letter_id: idSchema,
    source_revision_id: idSchema,
    source_hash: sourceHashSchema,
    provider_id: providerIdentifierSchema,
    provider_version: providerVersionSchema,
    processing_region: z.string().trim().min(1).max(64),
    retention_policy: z.enum(['zero', 'ephemeral', 'bounded']),
    retention_seconds: z.number().int().min(0).max(31_536_000),
    capability: z.literal('private_translation'),
    no_training: z.literal(true),
    expires_at: z.string().datetime({ offset: true }),
    revoked_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type TranslationConsent = z.infer<typeof translationConsentSchema>;
export const translationConsentResponseSchema = translationConsentSchema;
export const translationConsentRequestSchema = z
  .object({
    provider_id: providerIdentifierSchema,
    provider_version: providerVersionSchema,
    processing_region: z.string().trim().min(1).max(64),
    retention_policy: z.enum(['zero', 'ephemeral', 'bounded']),
    retention_seconds: z.number().int().min(0).max(31_536_000),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

export interface TranslationTask {
  id: string;
  ownerId: string;
  key: TranslationCacheKey;
  requestDigest: string;
  state: TranslationState;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  nextRetryAt: Date | null;
  leaseUntil: Date | null;
  lastErrorCode: string | null;
  consentBinding?: {
    id: string;
    providerVersion: string;
    processingRegion: string;
    retentionPolicy: 'zero' | 'ephemeral' | 'bounded';
    retentionSeconds: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface TranslationResult {
  taskId: string;
  key: TranslationCacheKey;
  sourceLocale: string;
  targetLocale: string;
  providerId: string;
  providerVersion: string;
  title: string;
  body: LetterBody;
  createdAt: Date;
}

export interface TranslationSourcePort {
  readPublicSource(
    viewerId: string,
    letterId: string,
  ): Promise<PublishedLetterRevisionSnapshot | null>;
  readPrivateSource(
    ownerId: string,
    letterId: string,
    revision?: number,
  ): Promise<LetterRevisionSnapshot | null>;
}

export interface TranslationProvider {
  capability: TranslationProviderCapability;
  translate(input: {
    sourceLocale: string;
    targetLocale: string;
    source: Pick<LetterContent, 'title' | 'body'>;
  }): Promise<unknown>;
}

export interface TranslationRepositoryPort {
  reapExpiredLeases(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ taskId: string; attempt: number; nextRetryAt: Date }>>;
  listDueWakeups(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ taskId: string; attempt: number; nextRetryAt: Date }>>;
  markWakeupEnqueued(input: {
    taskId: string;
    attempt: number;
    enqueuedAt: Date;
  }): Promise<boolean>;
  replay(input: {
    ownerId: string;
    requestDigest: string;
    idempotencyKey: string;
    consent?: {
      id: string;
      providerVersion: string;
      processingRegion: string;
      retentionPolicy: 'zero' | 'ephemeral' | 'bounded';
      retentionSeconds: number;
    };
  }): Promise<{ task: TranslationTask } | { fallback: TranslationFallbackResponse } | null>;
  saveFallbackReplay(input: {
    ownerId: string;
    requestDigest: string;
    idempotencyKey: string;
    fallback: TranslationFallbackResponse;
  }): Promise<TranslationFallbackResponse>;
  createOrReplay(input: {
    ownerId: string;
    key: TranslationCacheKey;
    requestDigest: string;
    idempotencyKey: string;
    consent?: {
      id: string;
      providerVersion: string;
      processingRegion: string;
      retentionPolicy: 'zero' | 'ephemeral' | 'bounded';
      retentionSeconds: number;
    };
    now?: Date;
  }): Promise<{ created: boolean; task: TranslationTask }>;
  claim(input: {
    workerId: string;
    now: Date;
    leaseSeconds: number;
    taskId?: string;
  }): Promise<TranslationTask | null>;
  complete(input: {
    taskId: string;
    leaseToken: string;
    output: TranslationProviderOutput;
    now?: Date;
  }): Promise<boolean>;
  fail(input: {
    taskId: string;
    leaseToken: string;
    errorCode: string;
    now?: Date;
  }): Promise<{ accepted: boolean; state: TranslationState; nextRetryAt: Date | null }>;
  cancel(input: {
    taskId: string;
    leaseToken: string;
    errorCode: string;
    now?: Date;
  }): Promise<boolean>;
  read(input: { taskId: string }): Promise<TranslationResult | null>;
  findLatest(input: {
    ownerId?: string;
    letterId: string;
    targetLocale: string;
    providerId?: string;
  }): Promise<TranslationTask | null>;
  findTask(taskId: string): Promise<TranslationTask | null>;
  saveConsent(input: TranslationConsent): Promise<TranslationConsent>;
  currentConsent(input: {
    ownerId: string;
    letterId: string;
    sourceRevisionId: string;
    sourceHash: string;
    providerId: string;
    providerVersion: string;
    processingRegion: string;
    retentionPolicy: 'zero' | 'ephemeral' | 'bounded';
    retentionSeconds: number;
    now: Date;
  }): Promise<TranslationConsent | null>;
  revokeConsent(input: { ownerId: string; consentId: string; now: Date }): Promise<boolean>;
}

export const translationResultSchema = z
  .object({
    task_id: idSchema,
    schema_version: z.literal(1),
    source_locale: bcp47LocaleSchema,
    target_locale: bcp47LocaleSchema,
    provider_id: providerIdentifierSchema,
    provider_version: providerVersionSchema,
    title: translatedTextSchema(160),
    body: z
      .object({ paragraphs: z.array(translatedTextSchema(2_000)).min(1).max(100) })
      .strict()
      .refine(
        (value) =>
          value.paragraphs.reduce((total, paragraph) => total + paragraph.length, 0) <= 20_000,
        'translation output is too large',
      ),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const translationReadResponseSchema = z
  .object({
    task_id: idSchema,
    state: translationStateSchema,
    source_locale: bcp47LocaleSchema,
    target_locale: bcp47LocaleSchema,
    machine_translated: z.literal(true),
    result: translationResultSchema.nullable(),
  })
  .strict();

export const translationFallbackResponseSchema = z
  .object({
    machine_translated: z.literal(false),
    source_locale: bcp47LocaleSchema,
    target_locale: bcp47LocaleSchema,
    original: z
      .object({
        title: translatedTextSchema(160),
        body: z
          .object({ paragraphs: z.array(translatedTextSchema(2_000)).min(1).max(100) })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type TranslationFallbackResponse = z.infer<typeof translationFallbackResponseSchema>;
