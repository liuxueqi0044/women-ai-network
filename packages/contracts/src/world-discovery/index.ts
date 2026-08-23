import { z } from 'zod';
import { idSchema } from '../ids.js';
import { countryCodeSchema } from '../eligibility/dto.js';
import {
  bcp47LocaleSchema,
  letterTopicSchema,
  letterTopics,
  type LetterBody,
} from '../letters/index.js';

/**
 * The accepted q length is 120 UTF-16 code units. JSON.stringify can escape an
 * unpaired surrogate as six ASCII bytes, so the worst accepted q is 720 bytes;
 * together with the 32-character supported locale and signed cursor envelope,
 * 2048 base64url payload characters leaves explicit encoding/schema headroom.
 */
export const WORLD_CURSOR_PAYLOAD_MAX = 2048;
export const WORLD_CURSOR_SIGNATURE_LENGTH = 64;
const base64urlSegment = '[A-Za-z0-9_-]';
export const worldCursorPayloadSchema = z
  .string()
  .regex(new RegExp(`^${base64urlSegment}{1,${WORLD_CURSOR_PAYLOAD_MAX}}$`));
export const worldCursorSignatureSchema = z
  .string()
  .regex(new RegExp(`^${base64urlSegment}{${WORLD_CURSOR_SIGNATURE_LENGTH}}$`));
export const worldCursorTokenSchema = z
  .string()
  .regex(
    new RegExp(
      `^${base64urlSegment}{1,${WORLD_CURSOR_PAYLOAD_MAX}}\\.${base64urlSegment}{${WORLD_CURSOR_SIGNATURE_LENGTH}}$`,
    ),
  );

export const worldDiscoveryQuerySchema = z
  .object({
    country: countryCodeSchema.optional(),
    locale: bcp47LocaleSchema.optional(),
    topic: letterTopicSchema.optional(),
    q: z
      .string()
      .trim()
      .max(120)
      .refine(
        (value) => value.split(/\s+/u).filter(Boolean).length <= 16,
        'search query has too many terms',
      )
      .refine((value) => !/[\\*%_]/.test(value), 'search query contains a wildcard')
      .transform((value) => (value.length === 0 ? undefined : value))
      .optional(),
    cursor: worldCursorTokenSchema.optional(),
    limit: z.coerce.number().int().min(1).max(30).default(20),
  })
  .strict();
export type WorldDiscoveryQuery = z.infer<typeof worldDiscoveryQuerySchema>;

const worldCursorFiltersSchema = z
  .object({
    country: countryCodeSchema.nullable(),
    locale: bcp47LocaleSchema.nullable(),
    topic: letterTopicSchema.nullable(),
    q: z.string().trim().min(1).max(120).nullable(),
    limit: z.number().int().min(1).max(30),
  })
  .strict();
const worldCursorBoundarySchema = z
  .object({
    publication_id: idSchema,
    published_at: z.string().datetime({ offset: true }).optional(),
    bookmark_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (value) => (value.published_at !== undefined) !== (value.bookmark_at !== undefined),
    'cursor boundary kind is invalid',
  );
export const worldCursorSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('fresh-diverse-v1'),
    viewer: idSchema,
    filters: worldCursorFiltersSchema,
    as_of: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    boundary: worldCursorBoundarySchema,
  })
  .strict();
export type WorldCursor = z.infer<typeof worldCursorSchema>;

export const worldLetterSchema = z
  .object({
    publication_id: idSchema,
    letter_id: idSchema,
    pen_name: z.string().trim().min(1).max(80),
    country_code: countryCodeSchema,
    locale: bcp47LocaleSchema,
    topics: z.array(letterTopicSchema).min(1).max(4),
    content_reminder: z.enum(['none', 'sensitive_content', 'personal_data']),
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(160),
    body: z
      .object({ paragraphs: z.array(z.string().trim().min(1).max(2000)).min(1).max(100) })
      .strict(),
    published_at: z.string().datetime({ offset: true }),
    bookmarked: z.boolean(),
  })
  .strict();
export type WorldLetter = z.infer<typeof worldLetterSchema>;

export const worldDiscoveryResponseSchema = z
  .object({
    items: z.array(worldLetterSchema),
    next_cursor: worldCursorTokenSchema.nullable(),
  })
  .strict();

export const bookmarkResponseSchema = z
  .object({
    publication_id: idSchema,
    bookmarked: z.boolean(),
    created_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type BookmarkResponse = z.infer<typeof bookmarkResponseSchema>;

export const bookmarkListResponseSchema = z
  .object({
    items: z.array(worldLetterSchema),
    next_cursor: worldCursorTokenSchema.nullable(),
  })
  .strict();

export interface WorldDiscoveryCandidate {
  publicationId: string;
  letterId: string;
  ownerId: string;
  penName: string;
  countryCode: string;
  locale: string;
  topics: string[];
  contentReminder: 'none' | 'sensitive_content' | 'personal_data';
  revision: number;
  title: string;
  body: LetterBody;
  publishedAt: Date;
  bookmarkCreatedAt?: Date;
  bookmarked: boolean;
}

export interface WorldDiscoveryRepositoryPort {
  discover(
    viewerId: string,
    query: WorldDiscoveryQuery,
  ): Promise<{ items: WorldDiscoveryCandidate[]; nextCursor: string | null; hasMore: boolean }>;
  get(viewerId: string, publicationId: string): Promise<WorldDiscoveryCandidate | null>;
  /** Re-checks the current publication/revision/index/account binding immediately before return/mutation. */
  recheck(viewerId: string, publicationId: string): Promise<WorldDiscoveryCandidate | null>;
  cursorAfter(
    viewerId: string,
    query: WorldDiscoveryQuery,
    boundary: { publicationId: string; publishedAt?: Date; bookmarkAt?: Date },
    sourceCursor?: string | null,
  ): string;
  bookmark(
    viewerId: string,
    publicationId: string,
    idempotencyKey: string,
  ): Promise<BookmarkResponse>;
  unbookmark(viewerId: string, publicationId: string): Promise<boolean>;
  isBookmarked(viewerId: string, publicationId: string): Promise<boolean>;
  listBookmarks(
    viewerId: string,
    query: Pick<WorldDiscoveryQuery, 'cursor' | 'limit'>,
  ): Promise<{ items: WorldDiscoveryCandidate[]; nextCursor: string | null; hasMore: boolean }>;
}

export { letterTopics };
