import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { TranslationTask } from '@wai/contracts';
import { PgTranslationAuthorization } from './authorization.js';

const viewer = '11111111-1111-4111-8111-111111111111';
const author = '22222222-2222-4222-8222-222222222222';
const letter = '33333333-3333-4333-8333-333333333333';
const revision = '44444444-4444-4444-8444-444444444444';
const source = {
  letterId: letter,
  ownerId: author,
  kind: 'public_letter' as const,
  state: 'published' as const,
  currentRevision: 1,
  revisionId: revision,
  revision: 1,
  sourceHash: 'a'.repeat(64),
  revisionCreatedAt: new Date(),
  content: {
    title: 'hello',
    body: { paragraphs: ['world'] },
    locale: 'en-US',
    country_code: 'US',
    topics: ['life_story'],
    content_reminder: 'none',
    pen_name: 'A',
  },
};
const row = (id: string) => ({
  id,
  age_band: 'youth',
  cohort_key: 'youth_16',
  assurance_level: 'externally_attested',
  derived_at: new Date('2026-08-19T00:00:00.000Z'),
  policy_id: '55555555-5555-4555-8555-555555555555',
  policy_revision: 2,
  policy_hash: 'b'.repeat(64),
});
const task = (ownerId: string): TranslationTask =>
  ({
    id: '66666666-6666-4666-8666-666666666666',
    ownerId,
    key: {
      source_kind: 'public_letter',
      letter_id: letter,
      source_revision_id: revision,
      source_revision: 1,
      source_hash: source.sourceHash,
      source_locale: 'en-US',
      target_locale: 'fr-FR',
      provider_id: 'test',
      provider_version: 'v1',
    },
    requestDigest: 'c'.repeat(64),
    state: 'leased',
    attempts: 1,
    maxAttempts: 3,
    leaseToken: 'd'.repeat(64),
    nextRetryAt: null,
    leaseUntil: new Date(Date.now() + 60_000),
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as TranslationTask;

function poolFor(rows: unknown[], partitionRows: unknown[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM iam.accounts')) return { rows, rowCount: rows.length };
    if (sql.includes('FROM safety.blocks')) return { rowCount: 0, rows: [] };
    if (sql.includes('partition_decisions'))
      return { rows: partitionRows, rowCount: partitionRows.length };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as Pool;
}

describe('production translation authorization', () => {
  it('does not hard-code adult for an eligible self/public translation', async () => {
    const pool = poolFor([row(viewer)]);
    const letters = {
      readPublishedRevision: vi.fn().mockResolvedValue({ ...source, ownerId: viewer }),
    };
    const result = await new PgTranslationAuthorization(pool, letters as never).authorize(
      task(viewer),
    );
    expect(result.reason).not.toBe('unavailable');
    expect(vi.mocked(pool.query).mock.calls).toHaveLength(2);
  });

  it('requires a fresh current-policy-bound cross-account partition allow', async () => {
    const pool = poolFor([row(viewer), row(author)], []);
    const letters = { readPublishedRevision: vi.fn().mockResolvedValue(source) };
    const result = await new PgTranslationAuthorization(pool, letters as never).authorize(
      task(viewer),
    );
    expect(result.allowed).toBe(false);
    const calls = vi.mocked(pool.query).mock.calls;
    expect(String(calls.at(-1)?.[0])).toContain("now() - interval '15 minutes'");
    expect(String(calls.at(-1)?.[0])).toContain('actor_policy_hash');
  });
});
