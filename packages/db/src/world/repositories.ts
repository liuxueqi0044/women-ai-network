import type { Pool } from 'pg';
import {
  worldCursorSchema,
  worldCursorPayloadSchema,
  worldCursorSignatureSchema,
  worldDiscoveryQuerySchema,
  letterPublicationSchema,
  type BookmarkResponse,
  type WorldDiscoveryCandidate,
  type WorldDiscoveryQuery,
  type WorldDiscoveryRepositoryPort,
  type WorldCursor,
} from '@wai/contracts';
import { hmacDigest, safeEqual } from '../crypto.js';

const CURSOR_TTL_MS = 10 * 60_000;
const CANDIDATE_LIMIT = 120;

export class WorldCursorError extends Error {
  constructor() {
    super('world cursor invalid');
    this.name = 'WorldCursorError';
  }
}
export class WorldBookmarkIdempotencyConflictError extends Error {
  constructor() {
    super('world bookmark idempotency conflict');
    this.name = 'WorldBookmarkIdempotencyConflictError';
  }
}
export class WorldPublicationNotFoundError extends Error {
  constructor() {
    super('world publication not found');
    this.name = 'WorldPublicationNotFoundError';
  }
}

export class PgWorldDiscoveryRepository implements WorldDiscoveryRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly hmacKey: Buffer,
  ) {}

  async discover(viewerId: string, rawQuery: WorldDiscoveryQuery) {
    const query = worldDiscoveryQuerySchema.parse(rawQuery);
    const now = Date.now();
    const decoded = query.cursor === undefined ? null : decodeCursor(query.cursor, this.hmacKey);
    const filters = filterDigest(query);
    if (
      decoded !== null &&
      (decoded.viewer !== viewerId || JSON.stringify(decoded.filters) !== JSON.stringify(filters))
    )
      throw new WorldCursorError();
    if (decoded?.boundary.bookmark_at !== undefined) throw new WorldCursorError();
    const asOf = decoded?.as_of ?? new Date(now).toISOString();
    const params: unknown[] = [viewerId, asOf];
    const where: string[] = [
      'i.indexed_at <= $2',
      'p.published_at <= $2',
      "l.state = 'published'",
      "l.kind = 'public_letter'",
      'p.revision_id = r.id',
      'p.source_hash = r.source_hash',
      'l.current_revision = r.revision',
      'i.revision_id = p.revision_id',
      'i.source_hash = p.source_hash',
      "a.state = 'enabled'",
    ];
    if (query.country !== undefined) {
      params.push(query.country);
      where.push(`i.country_code = $${params.length}`);
    }
    if (query.locale !== undefined) {
      params.push(query.locale);
      where.push(`i.locale = $${params.length}`);
    }
    if (query.topic !== undefined) {
      params.push(query.topic);
      where.push(`$${params.length} = ANY(i.topics)`);
    }
    if (query.q !== undefined) {
      params.push(query.q);
      const p = params.length;
      where.push(
        `(i.search_vector @@ plainto_tsquery('simple',$${p}) OR i.search_text ILIKE '%' || $${p} || '%' OR similarity(i.search_text,$${p}) >= 0.18)`,
      );
    }
    if (decoded?.boundary.published_at !== undefined) {
      params.push(decoded.boundary.published_at, decoded.boundary.publication_id);
      where.push(`(p.published_at, p.id) < ($${params.length - 1}, $${params.length})`);
    }
    const rawLimit = Math.min(CANDIDATE_LIMIT, Math.max(query.limit + 1, query.limit * 4));
    params.push(rawLimit);
    const result = await this.pool.query<Row>(
      `SELECT p.id AS publication_id,p.letter_id,l.owner_id,p.projection_json,p.published_at,
              EXISTS(SELECT 1 FROM world_discovery.bookmarks b WHERE b.viewer_id=$1 AND b.publication_id=p.id) AS bookmarked
         FROM world_discovery.discovery_index i
         JOIN letters.publications p ON p.id=i.publication_id
         JOIN letters.letters l ON l.id=p.letter_id
         JOIN letters.letter_revisions r ON r.id=p.revision_id
         JOIN iam.accounts a ON a.id=l.owner_id
         JOIN iam.accounts viewer_account ON viewer_account.id=$1 AND viewer_account.state='enabled'
        WHERE ${where.join(' AND ')}
        ORDER BY p.published_at DESC,p.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const items = result.rows.map(toCandidate);
    // The repository exposes bounded raw candidates to the service. A source
    // cursor, when needed, must therefore describe the last raw row actually
    // returned, never the UI page limit (which may be smaller than overscan).
    const last = result.rows.at(-1);
    let nextCursor: string | null = null;
    if (last !== undefined)
      nextCursor = encodeCursor(
        {
          version: 1,
          algorithm: 'fresh-diverse-v1',
          viewer: viewerId,
          filters,
          as_of: asOf,
          expires_at: decoded?.expires_at ?? new Date(now + CURSOR_TTL_MS).toISOString(),
          boundary: {
            published_at: last.published_at.toISOString(),
            publication_id: last.publication_id,
          },
        },
        this.hmacKey,
      );
    return { items, nextCursor, hasMore: result.rows.length === rawLimit };
  }

  async get(viewerId: string, publicationId: string): Promise<WorldDiscoveryCandidate | null> {
    const result = await this.pool.query<Row>(
      `SELECT p.id AS publication_id,p.letter_id,l.owner_id,p.projection_json,p.published_at,
              EXISTS(SELECT 1 FROM world_discovery.bookmarks b WHERE b.viewer_id=$1 AND b.publication_id=p.id) AS bookmarked
         FROM letters.publications p JOIN letters.letters l ON l.id=p.letter_id
         JOIN letters.letter_revisions r ON r.id=p.revision_id
         JOIN iam.accounts a ON a.id=l.owner_id
         JOIN iam.accounts viewer_account ON viewer_account.id=$1 AND viewer_account.state='enabled'
         JOIN world_discovery.discovery_index i ON i.publication_id=p.id
        WHERE p.id=$2 AND l.state='published' AND l.kind='public_letter' AND l.current_revision=r.revision
          AND p.source_hash=r.source_hash AND i.source_hash=p.source_hash AND i.revision_id=p.revision_id AND a.state='enabled'
          AND NOT EXISTS (
            SELECT 1 FROM safety.blocks sb
            WHERE sb.state='active' AND ((sb.blocker_account_id=$1 AND sb.blocked_account_id=l.owner_id)
              OR (sb.blocker_account_id=l.owner_id AND sb.blocked_account_id=$1))
          ) LIMIT 1`,
      [viewerId, publicationId],
    );
    return result.rows[0] === undefined ? null : toCandidate(result.rows[0]);
  }

  async recheck(viewerId: string, publicationId: string): Promise<WorldDiscoveryCandidate | null> {
    return this.get(viewerId, publicationId);
  }

  cursorAfter(
    viewerId: string,
    rawQuery: WorldDiscoveryQuery,
    boundary: { publicationId: string; publishedAt?: Date; bookmarkAt?: Date },
    sourceCursor?: string | null,
  ): string {
    const query = worldDiscoveryQuerySchema.parse(rawQuery);
    const source = sourceCursor ? decodeCursor(sourceCursor, this.hmacKey) : null;
    const filters = filterDigest(query);
    if (
      source !== null &&
      (source.viewer !== viewerId || JSON.stringify(source.filters) !== JSON.stringify(filters))
    )
      throw new WorldCursorError();
    const asOf = source?.as_of ?? new Date().toISOString();
    const publishedAt = boundary.publishedAt?.toISOString();
    const bookmarkAt = boundary.bookmarkAt?.toISOString();
    if ((publishedAt === undefined) === (bookmarkAt === undefined)) throw new WorldCursorError();
    return encodeCursor(
      {
        version: 1,
        algorithm: 'fresh-diverse-v1',
        viewer: viewerId,
        filters,
        as_of: asOf,
        expires_at: source?.expires_at ?? new Date(Date.now() + CURSOR_TTL_MS).toISOString(),
        boundary: {
          publication_id: boundary.publicationId,
          ...(publishedAt ? { published_at: publishedAt } : { bookmark_at: bookmarkAt }),
        },
      },
      this.hmacKey,
    );
  }

  async bookmark(
    viewerId: string,
    publicationId: string,
    idempotencyKey: string,
  ): Promise<BookmarkResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (idempotencyKey !== undefined) {
        const keyDigest = hmacDigest(this.hmacKey, 'world:bookmark-key', idempotencyKey);
        const payloadDigest = hmacDigest(this.hmacKey, 'world:bookmark-payload', publicationId);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${viewerId}:${keyDigest}`,
        ]);
        const prior = await client.query<{ payload_digest: string; result_json: BookmarkResponse }>(
          'SELECT payload_digest,result_json FROM world_discovery.bookmark_idempotency WHERE viewer_id=$1 AND key_digest=$2 FOR UPDATE',
          [viewerId, keyDigest],
        );
        if (prior.rows[0] !== undefined) {
          if (prior.rows[0].payload_digest !== payloadDigest)
            throw new WorldBookmarkIdempotencyConflictError();
          await client.query('COMMIT');
          return prior.rows[0].result_json;
        }
        const row = await client.query<{ created_at: Date }>(
          `INSERT INTO world_discovery.bookmarks(viewer_id,publication_id,created_at)
             SELECT $1,p.id,now() FROM letters.publications p
             JOIN letters.letters l ON l.id=p.letter_id
             JOIN letters.letter_revisions r ON r.id=p.revision_id
             JOIN iam.accounts a ON a.id=l.owner_id
             JOIN iam.accounts viewer_account ON viewer_account.id=$1 AND viewer_account.state='enabled'
             JOIN world_discovery.discovery_index i ON i.publication_id=p.id
            WHERE p.id=$2 AND l.kind='public_letter' AND l.state='published'
              AND l.current_revision=r.revision AND p.source_hash=r.source_hash
              AND i.revision_id=p.revision_id AND i.source_hash=p.source_hash AND a.state='enabled'
              AND NOT EXISTS (
                SELECT 1 FROM safety.blocks sb
                WHERE sb.state='active' AND ((sb.blocker_account_id=$1 AND sb.blocked_account_id=l.owner_id)
                  OR (sb.blocker_account_id=l.owner_id AND sb.blocked_account_id=$1))
              )
           ON CONFLICT(viewer_id,publication_id) DO UPDATE SET publication_id=EXCLUDED.publication_id RETURNING created_at`,
          [viewerId, publicationId],
        );
        if (row.rows[0] === undefined) throw new WorldPublicationNotFoundError();
        const value: BookmarkResponse = {
          publication_id: publicationId,
          bookmarked: true,
          created_at: (row.rows[0]?.created_at ?? new Date()).toISOString(),
        };
        await client.query(
          'INSERT INTO world_discovery.bookmark_idempotency(viewer_id,key_digest,payload_digest,result_json) VALUES($1,$2,$3,$4)',
          [viewerId, keyDigest, payloadDigest, JSON.stringify(value)],
        );
        await client.query('COMMIT');
        return value;
      }
      const row = await client.query<{ created_at: Date }>(
        `INSERT INTO world_discovery.bookmarks(viewer_id,publication_id,created_at)
           SELECT $1,p.id,now() FROM letters.publications p
           JOIN letters.letters l ON l.id=p.letter_id
           JOIN letters.letter_revisions r ON r.id=p.revision_id
           JOIN iam.accounts a ON a.id=l.owner_id
           JOIN iam.accounts viewer_account ON viewer_account.id=$1 AND viewer_account.state='enabled'
           JOIN world_discovery.discovery_index i ON i.publication_id=p.id
          WHERE p.id=$2 AND l.kind='public_letter' AND l.state='published'
            AND l.current_revision=r.revision AND p.source_hash=r.source_hash
            AND i.revision_id=p.revision_id AND i.source_hash=p.source_hash AND a.state='enabled'
            AND NOT EXISTS (
              SELECT 1 FROM safety.blocks sb
              WHERE sb.state='active' AND ((sb.blocker_account_id=$1 AND sb.blocked_account_id=l.owner_id)
                OR (sb.blocker_account_id=l.owner_id AND sb.blocked_account_id=$1))
            )
         ON CONFLICT(viewer_id,publication_id) DO UPDATE SET publication_id=EXCLUDED.publication_id RETURNING created_at`,
        [viewerId, publicationId],
      );
      if (row.rows[0] === undefined) throw new WorldPublicationNotFoundError();
      await client.query('COMMIT');
      return {
        publication_id: publicationId,
        bookmarked: true,
        created_at: (row.rows[0]?.created_at ?? new Date()).toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async unbookmark(viewerId: string, publicationId: string) {
    const result = await this.pool.query(
      'DELETE FROM world_discovery.bookmarks WHERE viewer_id=$1 AND publication_id=$2',
      [viewerId, publicationId],
    );
    return result.rowCount === 1;
  }
  async isBookmarked(viewerId: string, publicationId: string) {
    const result = await this.pool.query(
      'SELECT 1 FROM world_discovery.bookmarks WHERE viewer_id=$1 AND publication_id=$2',
      [viewerId, publicationId],
    );
    return result.rowCount === 1;
  }

  async listBookmarks(viewerId: string, input: Pick<WorldDiscoveryQuery, 'cursor' | 'limit'>) {
    const query = worldDiscoveryQuerySchema.pick({ cursor: true, limit: true }).parse(input);
    const now = Date.now();
    const decoded = query.cursor === undefined ? null : decodeCursor(query.cursor, this.hmacKey);
    const filters = filterDigest(query);
    if (
      decoded !== null &&
      (decoded.viewer !== viewerId || JSON.stringify(decoded.filters) !== JSON.stringify(filters))
    )
      throw new WorldCursorError();
    if (decoded?.boundary.published_at !== undefined) throw new WorldCursorError();
    const asOf = decoded?.as_of ?? new Date(now).toISOString();
    const params: unknown[] = [viewerId, asOf];
    const boundary = decoded?.boundary.bookmark_at !== undefined;
    const condition = boundary
      ? (() => {
          params.push(decoded.boundary.bookmark_at, decoded.boundary.publication_id);
          return `(b.created_at,b.publication_id) < ($3,$4)`;
        })()
      : 'TRUE';
    const rawLimit = Math.min(CANDIDATE_LIMIT, Math.max(query.limit + 1, query.limit * 4));
    params.push(rawLimit);
    const rows = await this.pool.query<Row>(
      `SELECT p.id AS publication_id,p.letter_id,l.owner_id,p.projection_json,p.published_at,b.created_at AS bookmark_at,TRUE AS bookmarked
      FROM world_discovery.bookmarks b JOIN letters.publications p ON p.id=b.publication_id JOIN letters.letters l ON l.id=p.letter_id JOIN letters.letter_revisions r ON r.id=p.revision_id JOIN world_discovery.discovery_index i ON i.publication_id=p.id JOIN iam.accounts a ON a.id=l.owner_id JOIN iam.accounts viewer_account ON viewer_account.id=$1 AND viewer_account.state='enabled'
      WHERE b.viewer_id=$1 AND b.created_at <= $2 AND ${condition} AND l.state='published' AND l.kind='public_letter' AND l.current_revision=r.revision AND p.source_hash=r.source_hash AND i.revision_id=p.revision_id AND i.source_hash=p.source_hash AND a.state='enabled' ORDER BY b.created_at DESC,b.publication_id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.rows.map(toCandidate);
    const last = rows.rows.at(-1);
    const nextCursor =
      last === undefined
        ? null
        : encodeCursor(
            {
              version: 1,
              algorithm: 'fresh-diverse-v1',
              viewer: viewerId,
              filters,
              as_of: asOf,
              expires_at: decoded?.expires_at ?? new Date(now + CURSOR_TTL_MS).toISOString(),
              boundary: {
                bookmark_at: (last.bookmark_at ?? last.published_at).toISOString(),
                publication_id: last.publication_id,
              },
            },
            this.hmacKey,
          );
    return { items, nextCursor, hasMore: rows.rows.length === rawLimit };
  }
}

type Row = {
  publication_id: string;
  letter_id: string;
  owner_id: string;
  projection_json: unknown;
  published_at: Date;
  bookmark_at?: Date;
  bookmarked: boolean;
};
function toCandidate(row: Row): WorldDiscoveryCandidate {
  const publication = letterPublicationSchema.parse(row.projection_json);
  return {
    publicationId: row.publication_id,
    letterId: row.letter_id,
    ownerId: row.owner_id,
    penName: publication.pen_name,
    countryCode: publication.country_code,
    locale: publication.locale,
    topics: publication.topics,
    contentReminder: publication.content_reminder,
    revision: publication.revision,
    title: publication.title,
    body: publication.body,
    publishedAt: row.published_at,
    ...(row.bookmark_at === undefined ? {} : { bookmarkCreatedAt: row.bookmark_at }),
    bookmarked: row.bookmarked,
  };
}
function filterDigest(query: Partial<WorldDiscoveryQuery>) {
  return {
    country: query.country ?? null,
    locale: query.locale ?? null,
    topic: query.topic ?? null,
    q: query.q ?? null,
    limit: query.limit ?? 20,
  };
}
function encodeCursor(cursor: WorldCursor, key: Buffer): string {
  const normalized = worldCursorSchema.parse(cursor);
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  return `${payload}.${hmacDigest(key, 'world:cursor', payload)}`;
}
function decodeCursor(value: string, key: Buffer): WorldCursor {
  try {
    const parts = value.split('.');
    if (parts.length !== 2) throw new Error();
    const payload = parts[0];
    const signature = parts[1];
    if (
      payload === undefined ||
      signature === undefined ||
      !worldCursorPayloadSchema.safeParse(payload).success ||
      !worldCursorSignatureSchema.safeParse(signature).success ||
      !safeEqual(hmacDigest(key, 'world:cursor', payload), signature)
    )
      throw new Error();
    const parsed = worldCursorSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    const now = Date.now();
    if (Date.parse(parsed.expires_at) <= now || Date.parse(parsed.as_of) > now) throw new Error();
    return parsed;
  } catch {
    throw new WorldCursorError();
  }
}
