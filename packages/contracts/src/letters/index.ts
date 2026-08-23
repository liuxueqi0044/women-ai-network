import { z } from 'zod';
import { idSchema } from '../ids.js';
import { countryCodeSchema } from '../eligibility/dto.js';

export const letterKindSchema = z.enum(['public_letter', 'private_letter']);
export type LetterKind = z.infer<typeof letterKindSchema>;
export const letterStateSchema = z.enum(['draft', 'published', 'withdrawn', 'archived']);
export type LetterState = z.infer<typeof letterStateSchema>;

export const letterTopicSchema = z.enum([
  'life_story',
  'family',
  'relationships',
  'migration',
  'values_beliefs',
  'work',
  'friendship',
  'culture',
  'education',
  'language_learning',
  'professional',
  'travel',
  'nature',
  'wellbeing',
  'technology',
]);
export type LetterTopic = z.infer<typeof letterTopicSchema>;
export const letterTopics = letterTopicSchema.options;

export const contentReminderSchema = z.enum(['none', 'sensitive_content', 'personal_data']);
export type ContentReminder = z.infer<typeof contentReminderSchema>;

const noMarkup = (value: string): boolean =>
  !/[<>]/.test(value) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);

const safePlainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(noMarkup, 'HTML and control characters are not accepted')
    .refine((value) => !/[\r\n]/.test(value), 'use structured paragraphs instead of newlines');
export const plainTextSchema = safePlainText(4000);

export const letterBodySchema = z
  .object({
    paragraphs: z.array(safePlainText(2000)).min(1).max(100),
  })
  .strict()
  .refine(
    (value) => value.paragraphs.reduce((total, paragraph) => total + paragraph.length, 0) <= 20_000,
    'letter body must not exceed 20000 characters',
  );
export type LetterBody = z.infer<typeof letterBodySchema>;

// Product content locales intentionally use a bounded canonical-casing
// grammar: language, optional title-case script, and optional alpha-2 or
// numeric-3 region. Extensions, variants, private-use tags, and registry
// alias canonicalization are outside this content-locale contract; this is
// not a full BCP-47/CLDR/IANA registry implementation.
const contentLocalePattern = /^[a-z]{2,8}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
export const bcp47LocaleSchema = z
  .string()
  .max(32)
  .regex(contentLocalePattern, 'must use the supported content-locale grammar');

export const penNameSchema = safePlainText(80);
export const letterContentSchema = z
  .object({
    title: safePlainText(160),
    body: letterBodySchema,
    locale: bcp47LocaleSchema,
    country_code: countryCodeSchema,
    topics: z
      .array(letterTopicSchema)
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length, 'topics must not repeat'),
    content_reminder: contentReminderSchema,
    pen_name: penNameSchema,
  })
  .strict();
export type LetterContent = z.infer<typeof letterContentSchema>;

export const letterCreateRequestSchema = letterContentSchema
  .extend({ kind: letterKindSchema })
  .strict();
export type LetterCreateRequest = z.infer<typeof letterCreateRequestSchema>;

export const letterPatchRequestSchema = letterContentSchema.partial().strict();
export type LetterPatchRequest = z.infer<typeof letterPatchRequestSchema>;

export const letterRevisionSchema = z
  .object({
    id: idSchema,
    revision: z.number().int().positive(),
    source_hash: z.string().regex(/^[0-9a-f]{64}$/),
    key_id: z.string().min(1).max(128),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1),
  })
  .strict();
export type LetterRevision = z.infer<typeof letterRevisionSchema>;

export const letterOwnerResponseSchema = z
  .object({
    id: idSchema,
    kind: letterKindSchema,
    state: letterStateSchema,
    version: z.number().int().nonnegative(),
    title: safePlainText(160),
    body: letterBodySchema,
    locale: bcp47LocaleSchema,
    country_code: countryCodeSchema,
    topics: z.array(letterTopicSchema).min(1).max(4),
    content_reminder: contentReminderSchema,
    pen_name: penNameSchema,
    revision: z.number().int().positive(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type LetterOwnerResponse = z.infer<typeof letterOwnerResponseSchema>;

export const letterPublicationSchema = z
  .object({
    id: idSchema,
    pen_name: penNameSchema,
    country_code: countryCodeSchema,
    locale: bcp47LocaleSchema,
    topics: z.array(letterTopicSchema).min(1).max(4),
    content_reminder: contentReminderSchema,
    revision: z.number().int().positive(),
    title: safePlainText(160),
    body: letterBodySchema,
  })
  .strict();
export type LetterPublication = z.infer<typeof letterPublicationSchema>;

export interface LetterRecord {
  id: string;
  ownerId: string;
  kind: LetterKind;
  state: LetterState;
  version: number;
  revision: number;
  content: LetterContent;
  updatedAt: Date;
}

/** Owner-bound immutable source snapshot for translation/private-letter consumers. */
export interface LetterRevisionSnapshot {
  letterId: string;
  ownerId: string;
  kind: LetterKind;
  state: LetterState;
  currentRevision: number;
  revisionId: string;
  revision: number;
  sourceHash: string;
  content: LetterContent;
  revisionCreatedAt: Date;
}

/** Publication-bound source binding; no private/unpublished revision is exposed. */
export interface PublishedLetterRevisionSnapshot {
  letterId: string;
  ownerId: string;
  kind: 'public_letter';
  state: 'published';
  currentRevision: number;
  revisionId: string;
  revision: number;
  sourceHash: string;
  content: LetterContent;
  revisionCreatedAt: Date;
}

export const letterSummarySchema = z
  .object({
    id: idSchema,
    kind: letterKindSchema,
    state: letterStateSchema,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type LetterSummary = z.infer<typeof letterSummarySchema>;
export const letterListQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,256}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const letterListResponseSchema = z
  .object({
    items: z.array(letterSummarySchema),
    next_cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,256}$/)
      .nullable(),
  })
  .strict();

export interface LetterRepositoryPort {
  create(input: {
    ownerId: string;
    kind: LetterKind;
    content: LetterContent;
    idempotencyKey: string;
  }): Promise<LetterRecord>;
  autosave(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    content: { [K in keyof LetterContent]?: LetterContent[K] | undefined };
    idempotencyKey: string;
  }): Promise<LetterRecord>;
  getOwned(ownerId: string, letterId: string): Promise<LetterRecord | null>;
  /** Authorized owner-bound historical snapshot for downstream letter-aware modules. */
  readOwnedRevision(
    ownerId: string,
    letterId: string,
    revision: number,
  ): Promise<LetterRevisionSnapshot | null>;
  getPublished(letterId: string): Promise<{
    ownerId: string;
    publication: LetterPublication;
    source: { revisionId: string; revision: number; sourceHash: string };
  } | null>;
  readPublishedRevision(letterId: string): Promise<PublishedLetterRevisionSnapshot | null>;
  listOwned(
    ownerId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{
    items: LetterSummary[];
    nextCursor: string | null;
  }>;
  publish(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<LetterRecord>;
  withdraw(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<LetterRecord>;
  archive(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<LetterRecord>;
  replay(input: {
    ownerId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<LetterRecord | null>;
}
