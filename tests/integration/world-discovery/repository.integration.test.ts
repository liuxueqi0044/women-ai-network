import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  createPool,
  MigrationRunner,
  PgWorldDiscoveryRepository,
  WorldCursorError,
  WorldPublicationNotFoundError,
} from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import {
  bcp47LocaleSchema,
  worldCursorTokenSchema,
  worldDiscoveryQuerySchema,
  worldDiscoveryResponseSchema,
} from '@wai/contracts';

declare const WAI_MIGRATIONS_DIR: string;
let infra: StartedInfra;
let pool: Pool;
let repo: PgWorldDiscoveryRepository;
const viewer = '00000000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const key = Buffer.alloc(32, 7);

beforeAll(async () => {
  infra = await startTestInfra();
  pool = createPool(infra.infra.databaseUrl);
  const runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, {
    through: '0013_world_discovery.sql',
  });
  await runner.up();
  const now = new Date();
  for (const [id, email] of [
    [viewer, 'viewer'],
    [owner, 'owner'],
    [other, 'other'],
  ])
    await pool.query(
      `INSERT INTO iam.accounts(id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at) VALUES($1,$2,'x','x','k','enabled','registered','system',$3,$3,$3)`,
      [id, email, now],
    );
  for (const [index, accountId] of [
    [1, owner],
    [2, owner],
    [3, other],
  ] as const) {
    const client = await pool.connect();
    await client.query('BEGIN');
    const letterId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const revisionId = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
    await client.query(
      `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at,published_at) VALUES($1,$2,'public_letter','draft',1,1,$3,$3,NULL)`,
      [letterId, accountId, new Date(now.getTime() - index * 1000)],
    );
    await client.query(
      `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at) VALUES($1,$2,1,$3,'x','x','x','x','x','x','k',$4)`,
      [revisionId, letterId, 'a'.repeat(64), now],
    );
    await client.query(
      `UPDATE letters.letters SET state='published',version=2,published_at=$1,updated_at=$1 WHERE id=$2`,
      [now, letterId],
    );
    await client.query(
      `INSERT INTO letters.publications(id,letter_id,revision_id,source_hash,projection_json,published_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
        letterId,
        revisionId,
        'a'.repeat(64),
        JSON.stringify({
          id: letterId,
          pen_name: `Reader ${index}`,
          country_code: index === 3 ? 'CA' : 'US',
          locale: 'en-US',
          topics: ['travel'],
          content_reminder: 'none',
          revision: 1,
          title: `Letter ${index}`,
          body: { paragraphs: [`Paragraph ${index}`] },
        }),
        now,
      ],
    );
    await client.query('COMMIT');
    client.release();
  }
  repo = new PgWorldDiscoveryRepository(pool, key);
});
afterAll(async () => {
  await pool?.end();
  await infra?.stop();
});

describe('WLD-01 real PostgreSQL repository', () => {
  it('fresh/no-op/down/up migration lifecycle is reversible', async () => {
    const runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, {
      through: '0013_world_discovery.sql',
    });
    const noop = await runner.up();
    expect(noop.applied).toEqual([]);
    expect(noop.skipped.at(-1)).toBe('0013_world_discovery.sql');
    expect(await runner.down()).toBe('0013_world_discovery.sql');
    expect(
      (await pool.query("SELECT to_regclass('world_discovery.bookmarks') AS name")).rows[0]?.name,
    ).toBeNull();
    expect((await runner.up()).applied.at(-1)).toBe('0013_world_discovery.sql');
    await pool.query(`INSERT INTO world_discovery.discovery_index(publication_id,letter_id,revision_id,source_hash,country_code,locale,topics,search_text,search_vector,indexed_at)
      SELECT p.id,p.letter_id,p.revision_id,p.source_hash,p.projection_json->>'country_code',p.projection_json->>'locale',ARRAY(SELECT jsonb_array_elements_text(p.projection_json->'topics')),left(p.projection_json->>'title',25000),to_tsvector('simple',left(p.projection_json->>'title',25000)),p.published_at FROM letters.publications p`);
  });
  it('database matches the content-locale grammar and rejects invalid country/topics', async () => {
    const base = {
      publication: '00000000-0000-4000-8000-000000000021',
      letter: '00000000-0000-4000-8000-000000000001',
      revision: '00000000-0000-4000-8000-000000000011',
      hash: 'a'.repeat(64),
    };
    await pool.query('DELETE FROM world_discovery.discovery_index WHERE publication_id=$1', [
      base.publication,
    ]);
    const insert = (country: string, locale: string, topics: string[]) =>
      pool.query(
        `INSERT INTO world_discovery.discovery_index(publication_id,letter_id,revision_id,source_hash,country_code,locale,topics,search_text,search_vector,indexed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'x',to_tsvector('simple','x'),now())`,
        [base.publication, base.letter, base.revision, base.hash, country, locale, topics],
      );
    await expect(insert('USA', 'en-US', ['travel'])).rejects.toThrow();
    await expect(insert('US', 'en-us', ['travel'])).rejects.toThrow();
    await expect(insert('US', 'en-US', ['travel', 'travel'])).rejects.toThrow();
    for (const locale of [
      'EN-US',
      'en_US',
      'en-u-ca-gregory',
      'en-x-private',
      'en-x-private-Latn',
      'en-US-Latn',
      'en-1901-1901',
      'en-a-aaa-a-bbb',
      'en-u-ca-gregory-a-aaa',
    ]) {
      await expect(insert('US', locale, ['travel'])).rejects.toThrow();
    }
    for (const locale of [
      'fr',
      'en-US',
      'zh-Hans-CN',
      'sr-Latn-RS',
      'es-419',
      'iw',
      'iw-IL',
      'in-ID',
      'ji',
      'en-BU',
      'sh',
      'mo',
    ]) {
      expect(bcp47LocaleSchema.parse(locale)).toBe(locale);
      await pool.query('DELETE FROM world_discovery.discovery_index WHERE publication_id=$1', [
        base.publication,
      ]);
      await insert('US', locale, ['travel']);
    }
    await pool.query('DELETE FROM world_discovery.discovery_index WHERE publication_id=$1', [
      base.publication,
    ]);
    await insert('US', 'en-US', ['travel']);
  });
  it('maximum legal filters produce a bounded cursor accepted by response and query contracts', async () => {
    const query = worldDiscoveryQuerySchema.parse({
      country: 'US',
      locale: 'abcdefgh-Abcd-419',
      topic: 'language_learning',
      q: '界'.repeat(120),
      limit: 30,
    });
    const cursor = repo.cursorAfter(viewer, query, {
      publicationId: '00000000-0000-4000-8000-000000000021',
      publishedAt: new Date('2026-08-18T23:59:00.000Z'),
    });
    expect(worldCursorTokenSchema.parse(cursor)).toBe(cursor);
    const payload = cursor.split('.')[0]!;
    expect(payload.length).toBeLessThanOrEqual(2048);
    expect(Buffer.from(payload, 'base64url').length).toBeLessThanOrEqual(2048);
    expect(
      worldDiscoveryQuerySchema.safeParse({
        ...query,
        cursor: `${'a'.repeat(2049)}.${'b'.repeat(64)}`,
      }).success,
    ).toBe(false);
    const response = worldDiscoveryResponseSchema.parse({ items: [], next_cursor: cursor });
    const nextQuery = worldDiscoveryQuerySchema.parse({ ...query, cursor: response.next_cursor });
    await expect(repo.discover(viewer, nextQuery)).resolves.toMatchObject({ items: [] });
    const surrogateQuery = worldDiscoveryQuerySchema.parse({
      ...query,
      q: '\ud800'.repeat(120),
    });
    const surrogateCursor = repo.cursorAfter(viewer, surrogateQuery, {
      publicationId: '00000000-0000-4000-8000-000000000021',
      publishedAt: new Date('2026-08-18T23:59:00.000Z'),
    });
    const surrogateResponse = worldDiscoveryResponseSchema.parse({
      items: [],
      next_cursor: surrogateCursor,
    });
    expect(
      worldDiscoveryQuerySchema.parse({ ...surrogateQuery, cursor: surrogateResponse.next_cursor })
        .cursor,
    ).toBe(surrogateCursor);
  });
  it('uses the bounded raw look-ahead limits of 80 and 120', async () => {
    const querySpy = vi.spyOn(pool, 'query');
    try {
      await repo.discover(viewer, { limit: 20, country: 'ZZ', locale: 'en-US', topic: 'travel' });
      expect(querySpy.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([80]));
      await repo.discover(viewer, { limit: 30, country: 'ZZ', locale: 'en-US', topic: 'travel' });
      expect(querySpy.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([120]));
    } finally {
      querySpy.mockRestore();
    }
  });
  it('world feed filters and signed cursor paginate without duplicates or omissions', async () => {
    const first = await repo.discover(viewer, {
      limit: 1,
      country: 'US',
      locale: 'en-US',
      topic: 'travel',
    });
    // The repository returns bounded raw overscan; the service applies the
    // visible page limit after final authorization and diversity gates.
    expect(first.items).toHaveLength(2);
    const stableCursor = repo.cursorAfter(
      viewer,
      { limit: 1, country: 'US', locale: 'en-US', topic: 'travel' },
      { publicationId: first.items[0]!.publicationId, publishedAt: first.items[0]!.publishedAt },
    );
    const second = await repo.discover(viewer, {
      limit: 1,
      country: 'US',
      locale: 'en-US',
      topic: 'travel',
      cursor: stableCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.publicationId).not.toBe(first.items[0]?.publicationId);
    await expect(
      repo.discover(other, {
        limit: 1,
        country: 'US',
        locale: 'en-US',
        topic: 'travel',
        cursor: stableCursor,
      }),
    ).rejects.toBeInstanceOf(WorldCursorError);
    await expect(
      repo.discover(viewer, {
        limit: 1,
        country: 'CA',
        locale: 'en-US',
        topic: 'travel',
        cursor: stableCursor,
      }),
    ).rejects.toBeInstanceOf(WorldCursorError);
    const [payload, signature] = stableCursor.split('.');
    await expect(
      repo.discover(viewer, {
        limit: 1,
        country: 'US',
        locale: 'en-US',
        topic: 'travel',
        cursor: `${payload}x.${signature}`,
      }),
    ).rejects.toBeInstanceOf(WorldCursorError);
  });
  it('stale index cannot bypass withdraw and bookmark is concurrent owner-bound', async () => {
    const publicationId = '00000000-0000-4000-8000-000000000021';
    expect(await repo.get(viewer, publicationId)).not.toBeNull();
    await pool.query(
      `UPDATE letters.letters SET state='withdrawn',version=3,withdrawn_at=now(),updated_at=now() WHERE id=$1`,
      ['00000000-0000-4000-8000-000000000001'],
    );
    expect(await repo.get(viewer, publicationId)).toBeNull();
    const second = '00000000-0000-4000-8000-000000000022';
    const results = await Promise.all([
      repo.bookmark(viewer, second, 'concurrent-bookmark-123456'),
      repo.bookmark(viewer, second, 'concurrent-bookmark-123456'),
    ]);
    expect(results[0]?.bookmarked).toBe(true);
    expect(results[1]?.bookmarked).toBe(true);
    expect(await repo.unbookmark(other, second)).toBe(false);
    expect(await repo.isBookmarked(viewer, second)).toBe(true);
    await pool.query(
      `INSERT INTO safety.blocks(id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at)
       VALUES($1,$2,$3,'privacy',$4,$5,'active',now())`,
      ['00000000-0000-4000-8000-000000000071', viewer, owner, 'd'.repeat(64), 'e'.repeat(64)],
    );
    expect(await repo.get(viewer, second)).toBeNull();
    await expect(repo.bookmark(viewer, second, 'blocked-bookmark-123456')).rejects.toBeInstanceOf(
      WorldPublicationNotFoundError,
    );
    await pool.query('DELETE FROM safety.blocks WHERE id=$1', [
      '00000000-0000-4000-8000-000000000071',
    ]);
  });
  it('cursor continuation preserves the original expiry and rejects after it', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-19T00:00:00.000Z') });
    try {
      const query = { limit: 1, country: 'US', locale: 'en-US', topic: 'travel' } as const;
      const first = repo.cursorAfter(viewer, query, {
        publicationId: '00000000-0000-4000-8000-000000000021',
        publishedAt: new Date('2026-08-18T23:59:00.000Z'),
      });
      const firstPayload = JSON.parse(
        Buffer.from(first.split('.')[0]!, 'base64url').toString('utf8'),
      ) as { expires_at: string };
      vi.setSystemTime(new Date('2026-08-19T00:01:00.000Z'));
      const continued = repo.cursorAfter(
        viewer,
        query,
        {
          publicationId: '00000000-0000-4000-8000-000000000022',
          publishedAt: new Date('2026-08-18T23:58:00.000Z'),
        },
        first,
      );
      const continuedPayload = JSON.parse(
        Buffer.from(continued.split('.')[0]!, 'base64url').toString('utf8'),
      ) as { expires_at: string };
      expect(continuedPayload.expires_at).toBe(firstPayload.expires_at);
      vi.setSystemTime(new Date(Date.parse(firstPayload.expires_at) + 1));
      await expect(repo.discover(viewer, { ...query, cursor: continued })).rejects.toBeInstanceOf(
        WorldCursorError,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('private publications never enter the discovery index', async () => {
    const now = new Date();
    const letterId = '00000000-0000-4000-8000-000000000031';
    const revisionId = '00000000-0000-4000-8000-000000000041';
    const publicationId = '00000000-0000-4000-8000-000000000051';
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at,published_at)
       VALUES($1,$2,'private_letter','draft',1,1,$3,$3,NULL)`,
      [letterId, owner, now],
    );
    await client.query(
      `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at)
       VALUES($1,$2,1,$3,'x','x','x','x','x','x','k',$4)`,
      [revisionId, letterId, 'b'.repeat(64), now],
    );
    await client.query('COMMIT');
    client.release();
    await expect(
      pool.query(
        `INSERT INTO letters.publications(id,letter_id,revision_id,source_hash,projection_json,published_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
        [
          publicationId,
          letterId,
          revisionId,
          'b'.repeat(64),
          JSON.stringify({
            id: letterId,
            pen_name: 'Private reader',
            country_code: 'US',
            locale: 'en-US',
            topics: ['travel'],
            content_reminder: 'none',
            revision: 1,
            title: 'Private title',
            body: { paragraphs: ['Private body'] },
          }),
          now,
        ],
      ),
    ).rejects.toThrow();
    expect(
      (
        await pool.query('SELECT 1 FROM world_discovery.discovery_index WHERE publication_id=$1', [
          publicationId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(await repo.get(viewer, publicationId)).toBeNull();
  });
  it('bounded raw scan keeps all 30 rows available across a limit-20 cursor', async () => {
    const now = Date.now();
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      for (let index = 0; index < 30; index += 1) {
        const suffix = (100 + index).toString().padStart(12, '0');
        const revisionSuffix = (500 + index).toString().padStart(12, '0');
        const publicationSuffix = (600 + index).toString().padStart(12, '0');
        const letterId = `00000000-0000-4000-8000-${suffix}`;
        const revisionId = `00000000-0000-4000-8000-${revisionSuffix}`;
        const publicationId = `00000000-0000-4000-8000-${publicationSuffix}`;
        const publishedAt = new Date(now - index * 1000);
        await client.query(
          `INSERT INTO letters.letters(id,owner_id,kind,state,version,current_revision,created_at,updated_at,published_at)
           VALUES($1,$2,'public_letter','draft',1,1,$3,$3,NULL)`,
          [letterId, owner, publishedAt],
        );
        await client.query(
          `INSERT INTO letters.letter_revisions(id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at)
           VALUES($1,$2,1,$3,'x','x','x','x','x','x','k',$4)`,
          [revisionId, letterId, 'c'.repeat(64), publishedAt],
        );
        await client.query(
          `UPDATE letters.letters SET state='published',version=2,published_at=$1,updated_at=$1 WHERE id=$2`,
          [publishedAt, letterId],
        );
        await client.query(
          `INSERT INTO letters.publications(id,letter_id,revision_id,source_hash,projection_json,published_at)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [
            publicationId,
            letterId,
            revisionId,
            'c'.repeat(64),
            JSON.stringify({
              id: letterId,
              pen_name: `Reader ${index}`,
              country_code: 'JP',
              locale: 'en-US',
              topics: ['travel'],
              content_reminder: 'none',
              revision: 1,
              title: `Bounded ${index}`,
              body: { paragraphs: [`Paragraph ${index}`] },
            }),
            publishedAt,
          ],
        );
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const query = { limit: 20, country: 'JP', locale: 'en-US', topic: 'travel' } as const;
    const raw = await repo.discover(viewer, query);
    expect(raw.items).toHaveLength(30);
    expect(raw.hasMore).toBe(false);
    expect(raw.nextCursor).not.toBeNull();
    const firstPage = raw.items.slice(0, 20);
    const cursor = repo.cursorAfter(viewer, query, {
      publicationId: firstPage[19]!.publicationId,
      publishedAt: firstPage[19]!.publishedAt,
    });
    const secondPage = await repo.discover(viewer, { ...query, cursor });
    expect(secondPage.items).toHaveLength(10);
    expect(new Set([...firstPage, ...secondPage.items].map((row) => row.publicationId)).size).toBe(
      30,
    );
  });
});
