import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { aesGcmDecrypt, aesGcmEncrypt, hmacDigest } from '../crypto.js';
import {
  letterContentSchema,
  idSchema,
  letterPublicationSchema,
  type LetterContent,
  type LetterKind,
  type LetterRevisionSnapshot,
  type LetterRecord,
  type LetterRepositoryPort,
  type LetterSummary,
  type PublishedLetterRevisionSnapshot,
  type LetterState,
} from '@wai/contracts';

export interface LetterKeyring {
  keyId: string;
  key: Buffer;
  keys?: ReadonlyMap<string, Buffer>;
  hmacKey?: Buffer;
}

export class LetterConcurrencyError extends Error {
  constructor() {
    super('letter version conflict');
    this.name = 'LetterConcurrencyError';
  }
}
export class LetterIdempotencyConflictError extends Error {
  constructor() {
    super('letter idempotency key payload conflict');
    this.name = 'LetterIdempotencyConflictError';
  }
}
export class LetterStateError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'LetterStateError';
  }
}
export class LetterNotFoundError extends Error {
  constructor() {
    super('letter not found');
    this.name = 'LetterNotFoundError';
  }
}

type LetterRow = {
  id: string;
  owner_id: string;
  kind: LetterKind;
  state: LetterState;
  version: number;
  current_revision: number;
  created_at: Date;
  updated_at: Date;
};
type RevisionRow = {
  id: string;
  revision: number;
  source_hash: string;
  title_ciphertext: string;
  title_nonce: string;
  body_ciphertext: string;
  body_nonce: string;
  metadata_ciphertext: string;
  metadata_nonce: string;
  key_id: string;
};
type JoinedRevisionRow = LetterRow &
  Omit<RevisionRow, 'id'> & {
    letter_id: string;
    revision_id: string;
    revision_created_at: Date;
  };

/** PostgreSQL-authoritative LTR aggregate. Plain source content exists only transiently. */
export class PgLetterRepository implements LetterRepositoryPort {
  private readonly encryptionKeys: ReadonlyMap<string, Buffer>;
  private readonly activeKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(
    private readonly pool: Pool,
    private readonly keyring: LetterKeyring,
  ) {
    if (keyring.key.length !== 32) throw new Error('letters_key_invalid');
    this.activeKey = keyring.key;
    this.encryptionKeys = keyring.keys ?? new Map([[keyring.keyId, keyring.key]]);
    this.hmacKey = keyring.hmacKey ?? keyring.key;
  }

  async create(input: {
    ownerId: string;
    kind: LetterKind;
    content: LetterContent;
    idempotencyKey: string;
  }): Promise<LetterRecord> {
    const content = letterContentSchema.parse(input.content);
    const payloadDigest = this.digest('request', JSON.stringify({ kind: input.kind, content }));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prior = await this.lockAndFindIdempotency(client, input.ownerId, input.idempotencyKey);
      if (prior !== null) {
        if (prior.payload_digest !== payloadDigest) throw new LetterIdempotencyConflictError();
        await client.query('COMMIT');
        return this.readPointer(input.ownerId, prior.result_json as Pointer);
      }
      const now = new Date();
      const letterId = randomUUID();
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO letters.letters
          (id,owner_id,kind,state,version,current_revision,created_at,updated_at)
         VALUES ($1,$2,$3,'draft',1,1,$4,$4)`,
        [letterId, input.ownerId, input.kind, now],
      );
      await this.insertRevision(client, revisionId, letterId, 1, content, now);
      await this.audit(
        client,
        input.ownerId,
        letterId,
        'letter.created',
        { kind: input.kind },
        now,
      );
      const pointer: Pointer = {
        letter_id: letterId,
        revision: 1,
        state: 'draft',
        version: 1,
        updated_at: now.toISOString(),
      };
      await this.insertIdempotency(
        client,
        input.ownerId,
        input.idempotencyKey,
        payloadDigest,
        pointer,
        now,
      );
      await client.query('COMMIT');
      return this.readPointer(input.ownerId, pointer);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async autosave(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    content: { [K in keyof LetterContent]?: LetterContent[K] | undefined };
    idempotencyKey: string;
  }): Promise<LetterRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inputDigest = this.digest(
        'request',
        JSON.stringify({
          letter_id: input.letterId,
          expected_version: input.expectedVersion,
          content: input.content,
        }),
      );
      const prior = await this.lockAndFindIdempotency(client, input.ownerId, input.idempotencyKey);
      if (prior !== null) {
        if (prior.payload_digest !== inputDigest) throw new LetterIdempotencyConflictError();
        await client.query('COMMIT');
        return this.readPointer(input.ownerId, prior.result_json as Pointer);
      }
      const row = await this.findLetterForUpdate(client, input.ownerId, input.letterId);
      if (row === null) throw new LetterNotFoundError();
      if (row.version !== input.expectedVersion) throw new LetterConcurrencyError();
      if (row.state !== 'draft') throw new LetterStateError('LETTER_NOT_EDITABLE');
      const current = await this.readRevision(client, row, row.current_revision);
      const merged = letterContentSchema.parse({
        ...current.content,
        ...input.content,
        ...(input.content.body === undefined ? {} : { body: input.content.body }),
      });
      const payloadDigest = inputDigest;
      const sourceHash = this.digest('source', JSON.stringify(merged));
      const now = new Date();
      let revision = row.current_revision;
      if (sourceHash !== current.sourceHash) {
        revision += 1;
        await this.insertRevision(client, randomUUID(), row.id, revision, merged, now);
        await client.query(
          `UPDATE letters.letters SET current_revision=$1,version=version+1,updated_at=$2 WHERE id=$3`,
          [revision, now, row.id],
        );
        await this.audit(client, input.ownerId, row.id, 'letter.autosaved', { revision }, now);
      }
      const pointer: Pointer = {
        letter_id: row.id,
        revision,
        state: row.state,
        version: sourceHash === current.sourceHash ? row.version : row.version + 1,
        updated_at: (sourceHash === current.sourceHash ? row.updated_at : now).toISOString(),
      };
      await this.insertIdempotency(
        client,
        input.ownerId,
        input.idempotencyKey,
        payloadDigest,
        pointer,
        now,
      );
      await client.query('COMMIT');
      return this.readPointer(input.ownerId, pointer);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getOwned(ownerId: string, letterId: string): Promise<LetterRecord | null> {
    try {
      return await this.readPointer(ownerId, { letter_id: letterId, revision: null });
    } catch (error) {
      if (error instanceof LetterNotFoundError) return null;
      throw error;
    }
  }

  async readOwnedRevision(
    ownerId: string,
    letterId: string,
    revision: number,
  ): Promise<LetterRevisionSnapshot | null> {
    try {
      return await this.readRevisionSnapshot(ownerId, letterId, revision);
    } catch (error) {
      if (error instanceof LetterNotFoundError) return null;
      throw error;
    }
  }

  async getPublished(letterId: string): Promise<{
    ownerId: string;
    publication: ReturnType<typeof letterPublicationSchema.parse>;
    source: { revisionId: string; revision: number; sourceHash: string };
  } | null> {
    const result = await this.pool.query<{
      owner_id: string;
      projection_json: unknown;
      revision_id: string;
      revision: number;
      source_hash: string;
    }>(
      `SELECT l.owner_id,p.projection_json,p.revision_id,r.revision,p.source_hash
         FROM letters.letters l
         JOIN letters.publications p ON p.letter_id=l.id
         JOIN letters.letter_revisions r ON r.id=p.revision_id AND r.letter_id=p.letter_id AND r.source_hash=p.source_hash
        WHERE l.id=$1 AND l.state='published'`,
      [letterId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ownerId: row.owner_id,
      publication: letterPublicationSchema.parse(row.projection_json),
      source: { revisionId: row.revision_id, revision: row.revision, sourceHash: row.source_hash },
    };
  }

  async readPublishedRevision(letterId: string): Promise<PublishedLetterRevisionSnapshot | null> {
    const result = await this.pool.query<JoinedRevisionRow>(
      `SELECT l.id AS letter_id,l.owner_id,l.kind,l.state,l.version,l.current_revision,l.created_at,l.updated_at,
              r.id AS revision_id,r.revision,r.source_hash,r.title_ciphertext,r.title_nonce,r.body_ciphertext,r.body_nonce,
              r.metadata_ciphertext,r.metadata_nonce,r.key_id,r.created_at AS revision_created_at
         FROM letters.letters l
         JOIN letters.publications p ON p.letter_id=l.id
         JOIN letters.letter_revisions r ON r.id=p.revision_id AND r.letter_id=p.letter_id AND r.source_hash=p.source_hash
        WHERE l.id=$1 AND l.kind='public_letter' AND l.state='published' AND p.revision_id=r.id
        LIMIT 1`,
      [letterId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const content = this.decryptContent(row);
    return {
      letterId: row.letter_id,
      ownerId: row.owner_id,
      kind: 'public_letter',
      state: 'published',
      currentRevision: row.current_revision,
      revisionId: row.revision_id,
      revision: row.revision,
      sourceHash: row.source_hash,
      content,
      revisionCreatedAt: row.revision_created_at,
    };
  }

  async listOwned(
    ownerId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{ items: LetterSummary[]; nextCursor: string | null }> {
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const result = await this.pool.query<{
      id: string;
      kind: LetterKind;
      state: LetterState;
      version: number;
      current_revision: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id,kind,state,version,current_revision,created_at,updated_at FROM letters.letters
       WHERE owner_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $4`,
      [ownerId, cursor?.created_at ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const page = result.rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(
        (row): LetterSummary => ({
          id: row.id,
          kind: row.kind,
          state: row.state,
          version: row.version,
          revision: row.current_revision,
          created_at: row.created_at.toISOString(),
          updated_at: row.updated_at.toISOString(),
        }),
      ),
      nextCursor:
        result.rows.length > query.limit && last !== undefined
          ? encodeCursor({ created_at: last.created_at.toISOString(), id: last.id })
          : null,
    };
  }

  async publish(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<LetterRecord> {
    return this.transition(input, 'publish');
  }
  async withdraw(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<LetterRecord> {
    return this.transition(input, 'withdraw');
  }
  async archive(input: {
    ownerId: string;
    letterId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<LetterRecord> {
    return this.transition(input, 'archive');
  }

  async replay(input: {
    ownerId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<LetterRecord | null> {
    const payloadDigest = this.digest('request', JSON.stringify(input.payload));
    const result = await this.pool.query<{ payload_digest: string; result_json: unknown }>(
      `SELECT payload_digest,result_json FROM letters.idempotency_keys WHERE owner_id=$1 AND key_digest=$2`,
      [input.ownerId, this.digest('idempotency-key', input.idempotencyKey)],
    );
    const prior = result.rows[0];
    if (prior === undefined) return null;
    if (prior.payload_digest !== payloadDigest) throw new LetterIdempotencyConflictError();
    return this.readPointer(input.ownerId, prior.result_json as Pointer);
  }

  private async transition(
    input: { ownerId: string; letterId: string; expectedVersion: number; idempotencyKey: string },
    action: 'publish' | 'withdraw' | 'archive',
  ): Promise<LetterRecord> {
    const payloadDigest = this.digest(
      'request',
      JSON.stringify({
        letter_id: input.letterId,
        expected_version: input.expectedVersion,
        action,
      }),
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prior = await this.lockAndFindIdempotency(client, input.ownerId, input.idempotencyKey);
      if (prior !== null) {
        if (prior.payload_digest !== payloadDigest) throw new LetterIdempotencyConflictError();
        await client.query('COMMIT');
        return this.readPointer(input.ownerId, prior.result_json as Pointer);
      }
      const row = await this.findLetterForUpdate(client, input.ownerId, input.letterId);
      if (row === null) throw new LetterNotFoundError();
      if (row.version !== input.expectedVersion) throw new LetterConcurrencyError();
      const now = new Date();
      let nextState: LetterState;
      if (action === 'publish') {
        if (row.kind !== 'public_letter' || row.state !== 'draft')
          throw new LetterStateError('LETTER_NOT_PUBLISHABLE');
        const revision = await this.readRevision(client, row, row.current_revision);
        const projection = {
          id: row.id,
          pen_name: revision.content.pen_name,
          country_code: revision.content.country_code,
          locale: revision.content.locale,
          topics: revision.content.topics,
          content_reminder: revision.content.content_reminder,
          revision: revision.revision,
          title: revision.content.title,
          body: revision.content.body,
        };
        nextState = 'published';
        await client.query(
          `UPDATE letters.letters SET state='published',published_at=$1,version=version+1,updated_at=$1 WHERE id=$2`,
          [now, row.id],
        );
        await client.query(
          `INSERT INTO letters.publications (id,letter_id,revision_id,source_hash,projection_json,published_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), row.id, revision.id, revision.sourceHash, JSON.stringify(projection), now],
        );
      } else if (action === 'withdraw') {
        if (row.state !== 'published') throw new LetterStateError('LETTER_NOT_WITHDRAWABLE');
        nextState = 'withdrawn';
        await client.query(
          `UPDATE letters.letters SET state='withdrawn',withdrawn_at=$1,version=version+1,updated_at=$1 WHERE id=$2`,
          [now, row.id],
        );
      } else {
        if (!['draft', 'withdrawn'].includes(row.state))
          throw new LetterStateError('LETTER_NOT_ARCHIVABLE');
        nextState = 'archived';
        await client.query(
          `UPDATE letters.letters SET state='archived',archived_at=$1,version=version+1,updated_at=$1 WHERE id=$2`,
          [now, row.id],
        );
      }
      await this.audit(
        client,
        input.ownerId,
        row.id,
        `letter.${action === 'publish' ? 'published' : action === 'withdraw' ? 'withdrawn' : 'archived'}`,
        { revision: row.current_revision },
        now,
      );
      const pointer: Pointer = {
        letter_id: row.id,
        revision: row.current_revision,
        state: nextState,
        version: row.version + 1,
        updated_at: now.toISOString(),
      };
      await this.insertIdempotency(
        client,
        input.ownerId,
        input.idempotencyKey,
        payloadDigest,
        pointer,
        now,
      );
      await client.query('COMMIT');
      const record = await this.readPointer(input.ownerId, pointer);
      return { ...record, state: nextState, version: record.version };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async readPointer(ownerId: string, pointer: Pointer): Promise<LetterRecord> {
    const params: unknown[] = [ownerId, pointer.letter_id];
    const revisionClause = pointer.revision === null ? '' : ' AND r.revision=$3';
    if (pointer.revision !== null) params.push(pointer.revision);
    const result = await this.pool.query<
      LetterRow & RevisionRow & { letter_id: string; revision_id: string }
    >(
      `SELECT l.id AS letter_id,l.owner_id,l.kind,l.state,l.version,l.current_revision,l.updated_at,
              l.created_at,
              r.id AS revision_id,r.revision,r.source_hash,r.title_ciphertext,r.title_nonce,r.body_ciphertext,r.body_nonce,r.metadata_ciphertext,r.metadata_nonce,r.key_id
         FROM letters.letters l JOIN letters.letter_revisions r ON r.letter_id=l.id
        WHERE l.owner_id=$1 AND l.id=$2${revisionClause}
        ORDER BY r.revision DESC LIMIT 1`,
      params,
    );
    const row = result.rows[0];
    if (row === undefined) throw new LetterNotFoundError();
    const content = this.decryptContent(row);
    return {
      id: row.letter_id,
      ownerId: row.owner_id,
      kind: row.kind,
      state: pointer.state ?? row.state,
      version: pointer.version ?? row.version,
      revision: row.revision,
      content,
      updatedAt: pointer.updated_at === undefined ? row.updated_at : new Date(pointer.updated_at),
    };
  }

  private async findLetterForUpdate(
    client: PoolClient,
    ownerId: string,
    letterId: string,
  ): Promise<LetterRow | null> {
    const result = await client.query<LetterRow>(
      `SELECT id,owner_id,kind,state,version,current_revision,created_at,updated_at FROM letters.letters WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
      [ownerId, letterId],
    );
    return result.rows[0] ?? null;
  }

  private async readRevision(
    client: PoolClient,
    row: LetterRow,
    revision: number,
  ): Promise<{ id: string; revision: number; sourceHash: string; content: LetterContent }> {
    const result = await client.query<RevisionRow>(
      `SELECT id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id FROM letters.letter_revisions WHERE letter_id=$1 AND revision=$2`,
      [row.id, revision],
    );
    const stored = result.rows[0];
    if (stored === undefined) throw new Error('letter_revision_missing');
    return {
      id: stored.id,
      revision: stored.revision,
      sourceHash: stored.source_hash,
      content: this.decryptContent({
        ...row,
        id: row.id,
        revision: stored.revision,
        source_hash: stored.source_hash,
        title_ciphertext: stored.title_ciphertext,
        title_nonce: stored.title_nonce,
        body_ciphertext: stored.body_ciphertext,
        body_nonce: stored.body_nonce,
        metadata_ciphertext: stored.metadata_ciphertext,
        metadata_nonce: stored.metadata_nonce,
        key_id: stored.key_id,
      }),
    };
  }

  private async readRevisionSnapshot(
    ownerId: string,
    letterId: string,
    revision: number,
  ): Promise<LetterRevisionSnapshot> {
    const result = await this.pool.query<JoinedRevisionRow>(
      `SELECT l.id AS letter_id,l.owner_id,l.kind,l.state,l.version,l.current_revision,l.created_at,l.updated_at,
              r.id AS revision_id,r.revision,r.source_hash,r.title_ciphertext,r.title_nonce,r.body_ciphertext,r.body_nonce,
              r.metadata_ciphertext,r.metadata_nonce,r.key_id,r.created_at AS revision_created_at
         FROM letters.letters l JOIN letters.letter_revisions r ON r.letter_id=l.id
        WHERE l.owner_id=$1 AND l.id=$2 AND r.revision=$3
        LIMIT 1`,
      [ownerId, letterId, revision],
    );
    const row = result.rows[0];
    if (row === undefined) throw new LetterNotFoundError();
    return {
      letterId: row.letter_id,
      ownerId: row.owner_id,
      kind: row.kind,
      state: row.state,
      currentRevision: row.current_revision,
      revisionId: row.revision_id,
      revision: row.revision,
      sourceHash: row.source_hash,
      content: this.decryptContent(row),
      revisionCreatedAt: row.revision_created_at,
    };
  }

  private decryptContent(row: LetterRow & RevisionRow): LetterContent {
    const key = this.encryptionKeys.get(row.key_id);
    if (key === undefined) throw new Error('letter_key_unavailable');
    const title = aesGcmDecrypt(key, {
      ciphertext: row.title_ciphertext,
      nonce: row.title_nonce,
    });
    const body = aesGcmDecrypt(key, {
      ciphertext: row.body_ciphertext,
      nonce: row.body_nonce,
    });
    return letterContentSchema.parse({
      title,
      body: JSON.parse(body) as unknown,
      ...(JSON.parse(
        aesGcmDecrypt(key, {
          ciphertext: row.metadata_ciphertext,
          nonce: row.metadata_nonce,
        }),
      ) as object),
    });
  }

  private async insertRevision(
    client: PoolClient,
    id: string,
    letterId: string,
    revision: number,
    content: LetterContent,
    now: Date,
  ): Promise<void> {
    const title = aesGcmEncrypt(this.activeKey, content.title);
    const body = aesGcmEncrypt(this.activeKey, JSON.stringify(content.body));
    const metadata = aesGcmEncrypt(
      this.activeKey,
      JSON.stringify({
        locale: content.locale,
        country_code: content.country_code,
        topics: content.topics,
        content_reminder: content.content_reminder,
        pen_name: content.pen_name,
      }),
    );
    await client.query(
      `INSERT INTO letters.letter_revisions (id,letter_id,revision,source_hash,title_ciphertext,title_nonce,body_ciphertext,body_nonce,metadata_ciphertext,metadata_nonce,key_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        letterId,
        revision,
        this.digest('source', JSON.stringify(content)),
        title.ciphertext,
        title.nonce,
        body.ciphertext,
        body.nonce,
        metadata.ciphertext,
        metadata.nonce,
        this.keyring.keyId,
        now,
      ],
    );
  }

  private async lockAndFindIdempotency(
    client: PoolClient,
    ownerId: string,
    key: string,
  ): Promise<{ payload_digest: string; result_json: unknown } | null> {
    const keyDigest = this.digest('idempotency-key', key);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${ownerId}:${keyDigest}`,
    ]);
    const result = await client.query<{ payload_digest: string; result_json: unknown }>(
      `SELECT payload_digest,result_json FROM letters.idempotency_keys WHERE owner_id=$1 AND key_digest=$2 FOR UPDATE`,
      [ownerId, keyDigest],
    );
    return result.rows[0] ?? null;
  }

  private async insertIdempotency(
    client: PoolClient,
    ownerId: string,
    key: string,
    payloadDigest: string,
    pointer: Pointer,
    now: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO letters.idempotency_keys (owner_id,key_digest,payload_digest,result_json,created_at) VALUES ($1,$2,$3,$4,$5)`,
      [ownerId, this.digest('idempotency-key', key), payloadDigest, JSON.stringify(pointer), now],
    );
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    letterId: string,
    eventType: string,
    metadata: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO letters.audit_events (actor_id,letter_id,event_type,metadata_json,created_at) VALUES ($1,$2,$3,$4,$5)`,
      [actorId, letterId, eventType, JSON.stringify(metadata), now],
    );
  }

  private digest(context: string, value: string): string {
    return hmacDigest(this.hmacKey, `letters:${context}`, value);
  }
}

type Pointer = {
  letter_id: string;
  revision: number | null;
  state?: LetterState;
  version?: number;
  updated_at?: string;
};

type LetterCursor = { created_at: string; id: string };
function encodeCursor(cursor: LetterCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
function decodeCursor(value: string): LetterCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid cursor');
    const candidate = parsed as { created_at?: unknown; id?: unknown };
    if (
      typeof candidate.created_at !== 'string' ||
      typeof candidate.id !== 'string' ||
      !idSchema.safeParse(candidate.id).success ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate.created_at) ||
      Number.isNaN(Date.parse(candidate.created_at))
    )
      throw new Error('invalid cursor');
    return { created_at: candidate.created_at, id: candidate.id };
  } catch {
    throw new Error('letter_cursor_invalid');
  }
}
