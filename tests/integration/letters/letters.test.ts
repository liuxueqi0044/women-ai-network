import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { loadEnv } from '@wai/config';
import { aesGcmEncrypt, MigrationRunner, PgLetterRepository, createPool } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import type { LetterContent } from '@wai/contracts';

declare const WAI_MIGRATIONS_DIR: string;

const OWNER = 'f1000000-0000-4000-8000-000000000001';
const VIEWER = 'f1000000-0000-4000-8000-000000000002';
let infra: StartedInfra;
let pool: Pool;
let repo: PgLetterRepository;
let vaultKey: Buffer;

const content: LetterContent = {
  title: 'A quiet beginning',
  body: { paragraphs: ['I am writing from a small city.', 'Tell me about your everyday life.'] },
  locale: 'en-US',
  country_code: 'US',
  topics: ['life_story', 'friendship'],
  content_reminder: 'none' as const,
  pen_name: 'Aurora',
};

beforeAll(async () => {
  infra = await startTestInfra();
  pool = createPool(infra.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  await pool.query(
    `INSERT INTO iam.accounts (id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at)
     VALUES ($1,'ltr-owner','cipher','nonce','key','enabled','registered','system',now(),now(),now()),
            ($2,'ltr-viewer','cipher','nonce','key','enabled','registered','system',now(),now(),now())`,
    [OWNER, VIEWER],
  );
  const config = loadEnv({ NODE_ENV: 'test', DATABASE_URL: infra.infra.databaseUrl });
  vaultKey = Buffer.from(JSON.parse(config.iam.piiKeysJson)[config.iam.piiKeyId], 'base64');
  repo = new PgLetterRepository(pool, { keyId: config.iam.piiKeyId, key: vaultKey });
});

afterAll(async () => {
  await pool?.query('DELETE FROM iam.accounts WHERE id IN ($1,$2)', [OWNER, VIEWER]);
  await pool?.end();
  await infra?.stop();
});

describe('LTR-01 PostgreSQL letter privacy and concurrency', () => {
  it('draft_and_private_letter_bodies_are_encrypted_at_rest', async () => {
    const letter = await repo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-private-create-0001',
    });
    const rows = await pool.query<{
      title_ciphertext: string;
      body_ciphertext: string;
      metadata_ciphertext: string;
    }>(
      'SELECT title_ciphertext,body_ciphertext,metadata_ciphertext FROM letters.letter_revisions WHERE letter_id=$1',
      [letter.id],
    );
    expect(JSON.stringify(rows.rows)).not.toContain('quiet beginning');
    expect(JSON.stringify(rows.rows)).not.toContain('small city');
    expect(rows.rows[0]?.body_ciphertext).toBeTruthy();
    expect(rows.rows[0]?.metadata_ciphertext).toBeTruthy();
  });

  it('owner_list_is_cursor_bounded_and_does_not_cross_account_boundary', async () => {
    const first = await repo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-list-create-0001',
    });
    await repo.create({
      ownerId: OWNER,
      kind: 'public_letter',
      content,
      idempotencyKey: 'ltr-list-create-0002',
    });
    await repo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-list-create-0003',
    });
    const page = await repo.listOwned(OWNER, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).not.toHaveProperty('body');
    expect(page.nextCursor).toBeTruthy();
    const next = await repo.listOwned(OWNER, { limit: 2, cursor: page.nextCursor! });
    expect(next.items.map((item) => item.id)).toContain(first.id);
    expect((await repo.listOwned(VIEWER, { limit: 50 })).items).toEqual([]);
    await expect(repo.listOwned(OWNER, { limit: 2, cursor: 'not-a-valid-cursor' })).rejects.toThrow(
      'letter_cursor_invalid',
    );
  });

  it('optimistic_autosave_does_not_lose_a_revision_and_replay_is_frozen', async () => {
    const created = await repo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-private-create-0002',
    });
    const patch = { body: { paragraphs: ['A revised paragraph.'] } };
    const requests = [
      { key: 'ltr-auto-a-0000001', content: patch },
      { key: 'ltr-auto-b-0000001', content: { body: { paragraphs: ['Another revision.'] } } },
    ];
    const results = await Promise.allSettled(
      requests.map((request) =>
        repo.autosave({
          ownerId: OWNER,
          letterId: created.id,
          expectedVersion: created.version,
          content: request.content,
          idempotencyKey: request.key,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winnerIndex = results.findIndex((r) => r.status === 'fulfilled');
    const winner = results[winnerIndex] as PromiseFulfilledResult<typeof created>;
    const replay = await repo.autosave({
      ownerId: OWNER,
      letterId: created.id,
      expectedVersion: created.version,
      content: requests[winnerIndex]!.content,
      idempotencyKey: requests[winnerIndex]!.key,
    });
    expect(replay.revision).toBe(winner.value.revision);
    expect(replay.content.body.paragraphs).toEqual(winner.value.content.body.paragraphs);
    await expect(
      repo.autosave({
        ownerId: OWNER,
        letterId: created.id,
        expectedVersion: created.version,
        content: { body: { paragraphs: ['conflicting replay'] } },
        idempotencyKey: requests[winnerIndex]!.key,
      }),
    ).rejects.toThrow('letter idempotency key payload conflict');
    expect(
      await pool.query(
        'SELECT count(*)::int AS count FROM letters.letter_revisions WHERE letter_id=$1',
        [created.id],
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
  });

  it('content_can_revert_without_reusing_an_immutable_revision', async () => {
    const created = await repo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-revert-create-0001',
    });
    const a = { body: { paragraphs: ['revision A'] } };
    const b = { body: { paragraphs: ['revision B'] } };
    const one = await repo.autosave({
      ownerId: OWNER,
      letterId: created.id,
      expectedVersion: 1,
      content: a,
      idempotencyKey: 'ltr-revert-a-0001',
    });
    const two = await repo.autosave({
      ownerId: OWNER,
      letterId: created.id,
      expectedVersion: one.version,
      content: b,
      idempotencyKey: 'ltr-revert-b-0001',
    });
    const three = await repo.autosave({
      ownerId: OWNER,
      letterId: created.id,
      expectedVersion: two.version,
      content: a,
      idempotencyKey: 'ltr-revert-a-0002',
    });
    expect(three.revision).toBe(4);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM letters.letter_revisions WHERE letter_id=$1',
          [created.id],
        )
      ).rows[0]?.count,
    ).toBe(4);
    const historical = await repo.readOwnedRevision(OWNER, created.id, 2);
    expect(historical).toMatchObject({
      letterId: created.id,
      ownerId: OWNER,
      revision: 2,
      content: { body: { paragraphs: ['revision A'] } },
    });
    expect(historical?.revisionId).toMatch(/[0-9a-f-]{36}/);
    expect(historical?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(historical?.currentRevision).toBe(4);
    expect(historical?.revisionCreatedAt).toBeInstanceOf(Date);
    await expect(repo.readOwnedRevision(VIEWER, created.id, 2)).resolves.toBeNull();
  });

  it('key_rotation_reads_old_revisions_and_preserves_hmac_idempotency', async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const hmacKey = randomBytes(32);
    const oldRepo = new PgLetterRepository(pool, {
      keyId: 'letters-old',
      key: oldKey,
      keys: new Map([['letters-old', oldKey]]),
      hmacKey,
    });
    const old = await oldRepo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-key-rotation-0001',
    });
    const rotated = new PgLetterRepository(pool, {
      keyId: 'letters-new',
      key: newKey,
      keys: new Map([
        ['letters-old', oldKey],
        ['letters-new', newKey],
      ]),
      hmacKey,
    });
    await expect(rotated.getOwned(OWNER, old.id)).resolves.toMatchObject({ id: old.id });
    await expect(
      rotated.create({
        ownerId: OWNER,
        kind: 'private_letter',
        content,
        idempotencyKey: 'ltr-key-rotation-0001',
      }),
    ).resolves.toMatchObject({ id: old.id });
    const retired = new PgLetterRepository(pool, {
      keyId: 'letters-new',
      key: newKey,
      keys: new Map([['letters-new', newKey]]),
      hmacKey,
    });
    await expect(retired.getOwned(OWNER, old.id)).rejects.toThrow('letter_key_unavailable');
  });

  it('published_projection_contains_only_member_safe_fields_and_withdraw_hides_it', async () => {
    const letter = await repo.create({
      ownerId: OWNER,
      kind: 'public_letter',
      content,
      idempotencyKey: 'ltr-public-create-0001',
    });
    const published = await repo.publish({
      ownerId: OWNER,
      letterId: letter.id,
      expectedVersion: letter.version,
      idempotencyKey: 'ltr-publish-0000001',
    });
    const projection = await pool.query<{ projection_json: Record<string, unknown> }>(
      'SELECT projection_json FROM letters.publications WHERE letter_id=$1',
      [letter.id],
    );
    expect(Object.keys(projection.rows[0]!.projection_json).sort()).toEqual(
      [
        'body',
        'content_reminder',
        'country_code',
        'id',
        'locale',
        'pen_name',
        'revision',
        'title',
        'topics',
      ].sort(),
    );
    expect(projection.rows[0]!.projection_json).not.toHaveProperty('owner_id');
    expect(await repo.getPublished(letter.id)).not.toBeNull();
    const publicationSource = await repo.readPublishedRevision(letter.id);
    expect(publicationSource).toMatchObject({
      letterId: letter.id,
      ownerId: OWNER,
      revisionId: (await repo.getPublished(letter.id))!.source.revisionId,
      sourceHash: (await repo.getPublished(letter.id))!.source.sourceHash,
    });
    expect(await repo.getOwned(VIEWER, letter.id)).toBeNull();
    const withdrawn = await repo.withdraw({
      ownerId: OWNER,
      letterId: letter.id,
      expectedVersion: published.version,
      idempotencyKey: 'ltr-withdraw-000001',
    });
    expect(withdrawn.state).toBe('withdrawn');
    expect(await repo.getPublished(letter.id)).toBeNull();
    const audit = await pool.query<{ event_type: string; metadata_json: Record<string, unknown> }>(
      'SELECT event_type,metadata_json FROM letters.audit_events WHERE letter_id=$1 ORDER BY id',
      [letter.id],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'letter.created',
      'letter.published',
      'letter.withdrawn',
    ]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/title|body/i);
  });

  it('database_guards_identity_revision_lifecycle_and_publication_binding', async () => {
    const letter = await repo.create({
      ownerId: OWNER,
      kind: 'public_letter',
      content,
      idempotencyKey: 'ltr-guard-create-0001',
    });
    const revision = await pool.query<{
      id: string;
      source_hash: string;
      title_ciphertext: string;
      title_nonce: string;
      body_ciphertext: string;
      body_nonce: string;
      metadata_ciphertext: string;
      metadata_nonce: string;
      key_id: string;
    }>(
      'SELECT id,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id FROM letters.letter_revisions WHERE letter_id=$1',
      [letter.id],
    );
    const stored = revision.rows[0]!;
    await expect(
      pool.query('UPDATE letters.letters SET owner_id=$1 WHERE id=$2', [VIEWER, letter.id]),
    ).rejects.toThrow();
    await expect(
      pool.query('UPDATE letters.letters SET updated_at=now() WHERE id=$1', [letter.id]),
    ).rejects.toThrow();
    await expect(
      pool.query('UPDATE letters.letters SET current_revision=3,version=3 WHERE id=$1', [
        letter.id,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO letters.letter_revisions
          (id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at)
         VALUES ($1,$2,3,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
        [
          randomUUID(),
          letter.id,
          stored.source_hash,
          stored.title_ciphertext,
          stored.title_nonce,
          stored.body_ciphertext,
          stored.body_nonce,
          stored.metadata_ciphertext,
          stored.metadata_nonce,
          stored.key_id,
        ],
      ),
    ).rejects.toThrow();

    const fake = await repo.create({
      ownerId: OWNER,
      kind: 'public_letter',
      content: { ...content, title: 'Bound publication source' },
      idempotencyKey: 'ltr-guard-create-0002',
    });
    const fakeLetter = fake.id;
    const fakeRevision = await pool.query<{ id: string; source_hash: string }>(
      'SELECT id,source_hash FROM letters.letter_revisions WHERE letter_id=$1 AND revision=1',
      [fakeLetter],
    );
    await expect(
      pool.query(
        `INSERT INTO letters.publications
          (id,letter_id,revision_id,source_hash,projection_json,published_at)
         VALUES ($1,$2,$3,$4,'{}',now())`,
        [randomUUID(), fakeLetter, stored.id, stored.source_hash],
      ),
    ).rejects.toThrow();
    await pool.query(
      `UPDATE letters.letters SET state='published',version=2,published_at=now(),updated_at=now() WHERE id=$1`,
      [fakeLetter],
    );
    await expect(
      pool.query(
        `INSERT INTO letters.publications
          (id,letter_id,revision_id,source_hash,projection_json,published_at)
         VALUES ($1,$2,$3,$4,'{}',now())`,
        [randomUUID(), fakeLetter, stored.id, stored.source_hash],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO letters.publications
          (id,letter_id,revision_id,source_hash,projection_json,published_at)
         VALUES ($1,$2,$3,$4,$5,now())`,
        [
          randomUUID(),
          fakeLetter,
          fakeRevision.rows[0]!.id,
          fakeRevision.rows[0]!.source_hash,
          JSON.stringify({ id: letter.id, revision: 999 }),
        ],
      ),
    ).rejects.toThrow();
    await pool.query('DELETE FROM letters.letters WHERE id=$1', [fakeLetter]);
  });

  it('rejects an initial letter aggregate without revision one', async () => {
    await expect(
      pool.query(
        `INSERT INTO letters.letters
          (id,owner_id,kind,state,version,current_revision,created_at,updated_at)
         VALUES ($1,$2,'public_letter','draft',1,1,now(),now())`,
        [randomUUID(), OWNER],
      ),
    ).rejects.toThrow(/initial revision is missing/);
  });

  it('rejects non-draft or terminal initial aggregate rows', async () => {
    const attempts = [
      `INSERT INTO letters.letters (id,owner_id,kind,state,version,current_revision,created_at,updated_at,published_at)
       VALUES ($1,$2,'public_letter','published',1,1,now(),now(),now())`,
      `INSERT INTO letters.letters (id,owner_id,kind,state,version,current_revision,created_at,updated_at)
       VALUES ($1,$2,'public_letter','draft',2,1,now(),now())`,
      `INSERT INTO letters.letters (id,owner_id,kind,state,version,current_revision,created_at,updated_at,archived_at)
       VALUES ($1,$2,'public_letter','draft',1,1,now(),now(),now())`,
    ];
    for (const statement of attempts) {
      await expect(pool.query(statement, [randomUUID(), OWNER])).rejects.toThrow();
    }
  });

  it('private_letter_cannot_publish_and_revisions_are_immutable', async () => {
    const letter = await repo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-private-create-0003',
    });
    await expect(
      repo.publish({
        ownerId: OWNER,
        letterId: letter.id,
        expectedVersion: letter.version,
        idempotencyKey: 'ltr-private-publish-0001',
      }),
    ).rejects.toThrow('LETTER_NOT_PUBLISHABLE');
    await expect(
      pool.query("UPDATE letters.letters SET state='published',published_at=now() WHERE id=$1", [
        letter.id,
      ]),
    ).rejects.toThrow();
    const revision = await pool.query<{ id: string }>(
      'SELECT id FROM letters.letter_revisions WHERE letter_id=$1',
      [letter.id],
    );
    await expect(
      pool.query('UPDATE letters.letter_revisions SET body_ciphertext=$1 WHERE id=$2', [
        'tampered',
        revision.rows[0]!.id,
      ]),
    ).rejects.toThrow();
  });

  it('tampered_ciphertext_or_decrypted_schema_fails_closed', async () => {
    const letter = await repo.create({
      ownerId: OWNER,
      kind: 'private_letter',
      content,
      idempotencyKey: 'ltr-private-tamper-0001',
    });
    const revision = await pool.query<{ id: string; body_nonce: string }>(
      'SELECT id,body_nonce FROM letters.letter_revisions WHERE letter_id=$1',
      [letter.id],
    );
    await pool.query(
      'ALTER TABLE letters.letter_revisions DISABLE TRIGGER letters_revisions_append_only',
    );
    try {
      const replacement = aesGcmEncrypt(
        vaultKey,
        JSON.stringify({ schemaVersion: 999, paragraphs: ['not a valid body'] }),
      );
      await pool.query(
        'UPDATE letters.letter_revisions SET body_ciphertext=$1,body_nonce=$2 WHERE id=$3',
        [replacement.ciphertext, replacement.nonce, revision.rows[0]!.id],
      );
    } finally {
      await pool.query(
        'ALTER TABLE letters.letter_revisions ENABLE TRIGGER letters_revisions_append_only',
      );
    }
    await expect(repo.getOwned(OWNER, letter.id)).rejects.toThrow();
  });
});
