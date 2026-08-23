/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { aesGcmDecrypt, aesGcmEncrypt, hmacDigest } from '../crypto.js';
import {
  circleMetadataSchema,
  circleCreateRequestSchema,
  circleListSchema,
  circleNotesSchema,
  circleMembersSchema,
  circleDetailSchema,
  circleJoinRequestsSchema,
  CircleDomainError,
  type CircleRepositoryPort,
  type CircleCreateRequest,
  type CirclePatchRequest,
  type CircleRole,
  type CircleGrowthGatePort,
} from '@wai/contracts';

export class CircleIdempotencyConflictError extends CircleDomainError {
  constructor() {
    super('CONFLICT');
  }
}
export class CircleNotFoundError extends CircleDomainError {
  constructor() {
    super('NOT_FOUND');
  }
}

type Cipher = { ciphertext: string; nonce: string; keyId: string };
type Row = Record<string, any>;
export class PgCircleRepository implements CircleRepositoryPort {
  private readonly keyring: ReadonlyMap<string, Buffer>;
  private readonly hmacKey: Buffer;
  constructor(
    private readonly pool: Pool,
    keyring: ReadonlyMap<string, Buffer> | Buffer,
    private readonly keyId = 'circle',
    private readonly gate: CircleGrowthGatePort,
    hmacKey?: Buffer,
  ) {
    this.keyring = Buffer.isBuffer(keyring)
      ? new Map([[keyId, keyring as Buffer]])
      : (keyring as ReadonlyMap<string, Buffer>);
    this.hmacKey =
      hmacKey ??
      this.keyring.get(keyId) ??
      (() => {
        throw new CircleDomainError('KEY_UNAVAILABLE');
      })();
  }
  private activeKey() {
    const key = this.keyring.get(this.keyId);
    if (!key) throw new CircleDomainError('KEY_UNAVAILABLE');
    return key;
  }
  private cipher(value: string): Cipher {
    const x = aesGcmEncrypt(this.activeKey(), value);
    return { ...x, keyId: this.keyId };
  }
  private decipher(row: Row, prefix: string): string | undefined {
    if (!row[`${prefix}_ciphertext`]) return undefined;
    const key = this.keyring.get(row[`${prefix}_key_id`]);
    if (!key) throw new CircleDomainError('KEY_UNAVAILABLE');
    return aesGcmDecrypt(key, {
      ciphertext: row[`${prefix}_ciphertext`],
      nonce: row[`${prefix}_nonce`],
    });
  }
  private cursor(
    actor: string,
    surface: 'circle-list' | 'circle-notes' | 'circle-members' | 'circle-join-requests',
    filter: string,
    updated: string,
    id: string,
  ) {
    const body = Buffer.from(
      JSON.stringify({ a: actor, s: surface, f: filter, u: updated, i: id }),
    ).toString('base64url');
    return `${body}.${hmacDigest(this.hmacKey, 'circle-cursor', body)}`;
  }
  private decodeCursor(
    value: string,
    actor: string,
    surface: 'circle-list' | 'circle-notes' | 'circle-members' | 'circle-join-requests',
    filter: string,
  ) {
    const [body, sig] = value.split('.');
    if (!body || !sig) throw new CircleDomainError('VALIDATION');
    const expected = hmacDigest(this.hmacKey, 'circle-cursor', body);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      throw new CircleDomainError('VALIDATION');
    let p: any;
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      throw new CircleDomainError('VALIDATION');
    }
    if (p.a !== actor || p.s !== surface || p.f !== filter || !p.u || !p.i)
      throw new CircleDomainError('VALIDATION');
    return p as { u: string; i: string };
  }
  private async idem(
    c: PoolClient,
    actor: string,
    operation: string,
    key: string,
    payload: string,
  ) {
    const idempotencyDigest = hmacDigest(this.hmacKey, 'circle-idempotency', key);
    const payloadDigest = hmacDigest(this.hmacKey, 'circle-payload', payload);
    const old = (
      await c.query(
        'SELECT payload_digest,result_json FROM circles.idempotency WHERE actor_account_id=$1 AND operation=$2 AND idempotency_digest=$3 FOR UPDATE',
        [actor, operation, idempotencyDigest],
      )
    ).rows[0];
    if (old && old.payload_digest !== payloadDigest) throw new CircleIdempotencyConflictError();
    return { idempotencyDigest, payloadDigest, old };
  }
  private async saveIdem(c: PoolClient, actor: string, operation: string, idem: any, result: any) {
    await c.query(
      'INSERT INTO circles.idempotency(actor_account_id,operation,idempotency_digest,payload_digest,result_json,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [actor, operation, idem.idempotencyDigest, idem.payloadDigest, result, new Date()],
    );
  }
  private audit(
    c: PoolClient,
    circleId: string,
    actorId: string,
    eventType: string,
    subjectId?: string,
    metadata: Record<string, string | number | boolean> = {},
  ) {
    return c.query(
      'INSERT INTO circles.audit_events(circle_id,actor_account_id,subject_account_id,event_type,metadata,created_at) VALUES($1,$2,$3,$4,$5,now())',
      [circleId, actorId, subjectId ?? null, eventType, JSON.stringify(metadata)],
    );
  }
  private async gateCheck(
    actor: string,
    circleId: string,
    operation: 'read' | 'mutate' | 'admit' | 'escape' | 'archive',
    requiredRole?: CircleRole,
    transaction?: PoolClient,
    subjectAccountId?: string,
  ) {
    const result = await this.gate.check({
      actorAccountId: actor,
      circleId,
      operation,
      ...(requiredRole ? { requiredRole } : {}),
      ...(transaction ? { transaction } : {}),
      ...(subjectAccountId ? { subjectAccountId } : {}),
    });
    if (!result.allowed) throw new CircleNotFoundError();
  }
  private metadata(row: Row, role: CircleRole | null, count: number) {
    return circleMetadataSchema.parse({
      id: row['id'],
      name: row['name'],
      description_available: Boolean(row['description_ciphertext']),
      lifecycle: row['lifecycle'],
      visibility: row['visibility'],
      mode: row['mode'],
      scope_kind: row['scope_kind'],
      country_code: row['country_code'] ?? null,
      city_label: row['city_label'] ?? null,
      topic_catalog_version: Number(row['topic_catalog_version']),
      topics: Array.isArray(row['topics']) ? row['topics'] : [],
      member_cap: Number(row['member_cap']),
      member_count: count,
      role,
      created_at: new Date(row['created_at']).toISOString(),
      updated_at: new Date(row['updated_at']).toISOString(),
    });
  }
  private async metadataFor(c: PoolClient | Pool, actor: string, id: string) {
    const row = (
      await c.query(
        "SELECT c.*,m.role,(SELECT count(*)::int FROM circles.memberships x WHERE x.circle_id=c.id AND x.state='active') AS member_count FROM circles.circles c LEFT JOIN circles.memberships m ON m.circle_id=c.id AND m.account_id=$1 AND m.state='active' WHERE c.id=$2",
        [actor, id],
      )
    ).rows[0];
    if (!row) throw new CircleNotFoundError();
    return this.metadata(row, row.role ?? null, Number(row.member_count));
  }
  async create(actor: string, input: CircleCreateRequest, digest: string, key: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `circle-owner:${actor}`,
      ]);
      const idem = await this.idem(c, actor, 'create', key, digest);
      if (idem.old) {
        await c.query('COMMIT');
        return idem.old.result_json;
      }
      const now = new Date(),
        id = randomUUID(),
        enc = input.description === undefined ? undefined : this.cipher(input.description);
      await c.query(
        'INSERT INTO circles.circles(id,owner_account_id,name,description_ciphertext,description_nonce,description_key_id,lifecycle,visibility,mode,scope_kind,country_code,city_label,topic_catalog_version,topics,member_cap,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)',
        [
          id,
          actor,
          input.name,
          enc?.ciphertext ?? null,
          enc?.nonce ?? null,
          enc?.keyId ?? null,
          input.lifecycle,
          input.visibility,
          input.mode,
          input.scope_kind,
          input.country_code ?? null,
          input.city_label ?? null,
          input.topic_catalog_version ?? 1,
          JSON.stringify(input.topics),
          input.member_cap,
          now,
        ],
      );
      await c.query(
        "INSERT INTO circles.memberships(id,circle_id,account_id,role,state,created_at,updated_at) VALUES($1,$2,$3,'owner','active',$4,$4)",
        [randomUUID(), id, actor, now],
      );
      await this.gateCheck(actor, id, 'read', undefined, c);
      await c.query(
        "INSERT INTO circles.audit_events(circle_id,actor_account_id,event_type,metadata,created_at) VALUES($1,$2,'circle.created',$3,$4)",
        [id, actor, JSON.stringify({ mode: input.mode, scope_kind: input.scope_kind }), now],
      );
      const result = await this.metadataFor(c, actor, id);
      await this.saveIdem(c, actor, 'create', idem, result);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async list(actor: string, input: { limit: number; cursor?: string; mode?: any }) {
    const filter = `${input.mode ?? ''}`;
    const c = input.cursor
      ? this.decodeCursor(input.cursor, actor, 'circle-list', filter)
      : undefined;
    const scanLimit = Math.max(input.limit * 10, 100);
    const rows = await this.pool.query(
      "SELECT c.*,m.role,(SELECT count(*)::int FROM circles.memberships x WHERE x.circle_id=c.id AND x.state='active') AS member_count,membership.updated_at AS scan_updated FROM circles.circles c JOIN circles.memberships membership ON membership.circle_id=c.id AND membership.account_id=$1 AND membership.state='active' LEFT JOIN circles.memberships m ON m.circle_id=c.id AND m.account_id=$1 AND m.state='active' WHERE ($2::text IS NULL OR c.mode=$2) AND ($3::timestamptz IS NULL OR (membership.updated_at,membership.circle_id) < ($3,$4::uuid)) ORDER BY membership.updated_at DESC,membership.circle_id DESC LIMIT $5",
      [actor, input.mode ?? null, c?.u ?? null, c?.i ?? null, scanLimit],
    );
    const items: ReturnType<typeof this.metadata>[] = [];
    let scanned = 0;
    for (const row of rows.rows) {
      scanned += 1;
      if (
        (await this.gate.check({ actorAccountId: actor, circleId: row.id, operation: 'read' }))
          .allowed
      )
        items.push(this.metadata(row, row.role, Number(row.member_count)));
      if (items.length >= input.limit) break;
    }
    const last = rows.rows[scanned - 1];
    return circleListSchema.parse({
      items,
      next_cursor:
        last && (scanned < rows.rows.length || rows.rows.length === scanLimit)
          ? this.cursor(
              actor,
              'circle-list',
              filter,
              new Date(last.scan_updated).toISOString(),
              last.id,
            )
          : null,
    });
  }
  async get(actor: string, id: string) {
    await this.gateCheck(actor, id, 'read');
    const row = (await this.pool.query('SELECT * FROM circles.circles WHERE id=$1', [id])).rows[0];
    if (!row) throw new CircleNotFoundError();
    const metadata = await this.metadataFor(this.pool, actor, id);
    return circleDetailSchema.parse({
      ...metadata,
      description: this.decipher(row, 'description') ?? null,
    });
  }
  async patch(actor: string, id: string, input: CirclePatchRequest, digest: string, key: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      const current = (await c.query('SELECT * FROM circles.circles WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!current) throw new CircleNotFoundError();
      if (input.mode !== undefined && input.mode !== current.mode)
        throw new CircleDomainError('CONFLICT');
      const idem = await this.idem(c, actor, `patch:${id}`, key, digest);
      if (idem.old) {
        await this.gateCheck(
          actor,
          id,
          current.lifecycle === 'archived' ? 'archive' : 'mutate',
          'owner',
          c,
        );
        await c.query('COMMIT');
        return idem.old.result_json;
      }
      if (current.lifecycle === 'archived') throw new CircleNotFoundError();
      const clearDescription = input.description === null;
      const enc =
        typeof input.description === 'string' ? this.cipher(input.description) : undefined;
      // Validate the complete next representation, rather than trusting a
      // partial patch to form a legal scope/topic combination in SQL.
      const next = circleCreateRequestSchema.parse({
        name: input.name ?? current.name,
        // Archive is a valid terminal transition but never a valid creation.
        lifecycle:
          (input.lifecycle ?? current.lifecycle) === 'archived'
            ? 'active'
            : (input.lifecycle ?? current.lifecycle),
        visibility: input.visibility ?? current.visibility,
        mode: input.mode ?? current.mode,
        scope_kind: input.scope_kind ?? current.scope_kind,
        ...(input.country_code === undefined
          ? current.country_code === null
            ? {}
            : { country_code: current.country_code }
          : input.country_code === null
            ? {}
            : { country_code: input.country_code }),
        ...(input.city_label === undefined
          ? current.city_label === null
            ? {}
            : { city_label: current.city_label }
          : input.city_label === null
            ? {}
            : { city_label: input.city_label }),
        topic_catalog_version: input.topic_catalog_version ?? current.topic_catalog_version,
        topics: input.topics ?? current.topics,
        member_cap: input.member_cap ?? current.member_cap,
      });
      const nextLifecycle = input.lifecycle ?? current.lifecycle;
      const activeCount = Number(
        (
          await c.query(
            "SELECT count(*)::int AS count FROM circles.memberships WHERE circle_id=$1 AND state='active'",
            [id],
          )
        ).rows[0]?.count ?? 0,
      );
      if (nextLifecycle !== 'archived' && current.lifecycle === 'archived')
        throw new CircleDomainError('CONFLICT');
      if (Number(next.member_cap) < activeCount) throw new CircleDomainError('CONFLICT');
      await this.gateCheck(actor, id, 'mutate', 'owner', c);
      await c.query(
        'UPDATE circles.circles SET name=$2,description_ciphertext=CASE WHEN $3::boolean THEN NULL WHEN $4::text IS NULL THEN description_ciphertext ELSE $4::text END,description_nonce=CASE WHEN $3::boolean THEN NULL WHEN $5::text IS NULL THEN description_nonce ELSE $5::text END,description_key_id=CASE WHEN $3::boolean THEN NULL WHEN $6::text IS NULL THEN description_key_id ELSE $6::text END,lifecycle=$7,visibility=$8,mode=$9,scope_kind=$10,country_code=$11,city_label=$12,topic_catalog_version=$13,topics=$14,member_cap=$15,updated_at=$16 WHERE id=$1',
        [
          id,
          input.name ?? current.name,
          clearDescription,
          enc?.ciphertext ?? null,
          enc?.nonce ?? null,
          enc?.keyId ?? null,
          nextLifecycle,
          next.visibility,
          next.mode,
          next.scope_kind,
          next.country_code ?? null,
          next.city_label ?? null,
          next.topic_catalog_version,
          JSON.stringify(next.topics),
          next.member_cap,
          new Date(),
        ],
      );
      await this.audit(c, id, actor, 'circle.patched');
      const result = await this.metadataFor(c, actor, id);
      await this.gateCheck(
        actor,
        id,
        nextLifecycle === 'archived' ? 'archive' : 'read',
        'owner',
        c,
      );
      await this.saveIdem(c, actor, `patch:${id}`, idem, result);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  private async membership(
    c: PoolClient,
    actor: string,
    id: string,
    roles: string[] = ['owner', 'moderator'],
  ) {
    const m = (
      await c.query(
        "SELECT role,state FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state='active'",
        [id, actor],
      )
    ).rows[0];
    if (!m || !roles.includes(m.role)) throw new CircleNotFoundError();
    return m;
  }
  private async pairLock(c: PoolClient, a: string, b: string) {
    const [left, right] = [a, b].sort();
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `connection:${left}:${right}`,
    ]);
  }
  private async pairLocks(c: PoolClient, actor: string, subjects: readonly string[]) {
    const keys = [
      ...new Set(subjects.map((subject) => `connection:${[actor, subject].sort().join(':')}`)),
    ].sort();
    for (const lockKey of keys)
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
  }
  async invite(actor: string, id: string, input: any, digest: string, key: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await this.pairLock(c, actor, input.account_id);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      await this.membership(c, actor, id);
      // The invitee is intentionally not a member yet. Admit semantics keep
      // the actor role requirement while applying pair authority to invitee.
      await this.gateCheck(actor, id, 'admit', 'moderator', c, input.account_id);
      // A completed invitation is a durable caller-visible result. Current
      // authority was checked above; replay must win over the later membership
      // conflict created by that very invitation's acceptance.
      const idem = await this.idem(c, actor, `invite:${id}`, key, digest);
      if (idem.old) {
        await c.query('COMMIT');
        return { invitationId: idem.old.result_json.invitationId };
      }
      const existingMembership = await c.query(
        "SELECT 1 FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state IN ('active','pending') FOR UPDATE",
        [id, input.account_id],
      );
      if (existingMembership.rowCount) throw new CircleDomainError('CONFLICT');
      // Idempotency is endpoint-scoped. The payload digest binds invitee and
      // role; putting either in operation would let one key fan out writes.
      const now = new Date(),
        // A short, server-owned deadline is part of the invitation generation.
        // It is intentionally not client supplied and never reaches NTF.
        expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        invitationId = randomUUID();
      // The pending unique index deliberately covers only current generations.
      // Expire under the same pair/circle locks before creating a replacement.
      await c.query(
        "UPDATE circles.invitations SET state='expired',updated_at=$3 WHERE circle_id=$1 AND invitee_account_id=$2 AND state='pending' AND expires_at<=$3",
        [id, input.account_id, now],
      );
      const invitation = (
        await c.query<{ id: string; role: 'member' | 'moderator' }>(
          "INSERT INTO circles.invitations(id,circle_id,inviter_account_id,invitee_account_id,role,state,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$7) ON CONFLICT (circle_id,invitee_account_id) WHERE state='pending' DO UPDATE SET updated_at=circles.invitations.updated_at RETURNING id,role",
          [invitationId, id, actor, input.account_id, input.role, expiresAt, now],
        )
      ).rows[0];
      if (!invitation || invitation.role !== input.role) throw new CircleDomainError('CONFLICT');
      const durableInvitationId = invitation.id;
      await c.query(
        "INSERT INTO circles.notification_handoff(id,circle_id,invitation_id,recipient_account_id,role,event_key,state,attempts,idempotency_digest,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'circle.invitation','pending',0,$6,$7,$7,$7) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          id,
          durableInvitationId,
          input.account_id,
          input.role,
          hmacDigest(this.hmacKey, 'circle-notification', durableInvitationId),
          now,
        ],
      );
      await c.query(
        "INSERT INTO circles.audit_events(circle_id,actor_account_id,subject_account_id,event_type,metadata,created_at) VALUES($1,$2,$3,'circle.invited',$4,$5)",
        [id, actor, input.account_id, JSON.stringify({ role: input.role }), now],
      );
      const result = { invitationId: durableInvitationId };
      await this.gateCheck(actor, id, 'read', undefined, c);
      await this.saveIdem(c, actor, `invite:${id}`, idem, result);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async join(actor: string, id: string, input: any, digest: string, key: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const circleState = (
        await c.query(
          'SELECT owner_account_id,lifecycle,visibility FROM circles.circles WHERE id=$1',
          [id],
        )
      ).rows[0] as { owner_account_id: string; lifecycle: string; visibility: string } | undefined;
      const owner = circleState?.owner_account_id;
      if (!owner) throw new CircleNotFoundError();
      if (circleState.lifecycle !== 'active' || circleState.visibility !== 'approval_required')
        throw new CircleNotFoundError();
      await this.pairLock(c, actor, owner);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      const circle = (await c.query('SELECT * FROM circles.circles WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!circle) throw new CircleNotFoundError();
      // The pre-lock lookup is advisory only. A concurrent owner/visibility
      // change must not let this request create a stale pending membership.
      if (
        circle.owner_account_id !== owner ||
        circle.lifecycle !== 'active' ||
        circle.visibility !== 'approval_required'
      )
        throw new CircleNotFoundError();
      const pendingInvitation = await c.query(
        "SELECT 1 FROM circles.invitations WHERE circle_id=$1 AND invitee_account_id=$2 AND state='pending' FOR UPDATE",
        [id, actor],
      );
      if (pendingInvitation.rowCount) throw new CircleDomainError('CONFLICT');
      await this.gateCheck(actor, id, 'admit', undefined, c, circle.owner_account_id);
      const idem = await this.idem(c, actor, `join:${id}`, key, digest);
      if (idem.old) {
        await c.query('COMMIT');
        return;
      }
      const existing = (
        await c.query(
          "SELECT 1 FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state IN ('active','pending')",
          [id, actor],
        )
      ).rowCount;
      if (existing) throw new CircleDomainError('CONFLICT');
      const enc = input.message === undefined ? undefined : this.cipher(input.message),
        now = new Date();
      await c.query(
        "INSERT INTO circles.memberships(id,circle_id,account_id,role,state,created_at,updated_at) VALUES($1,$2,$3,'member','pending',$4,$4)",
        [randomUUID(), id, actor, now],
      );
      await c.query(
        "INSERT INTO circles.join_requests(id,circle_id,account_id,message_ciphertext,message_nonce,message_key_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$7) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          id,
          actor,
          enc?.ciphertext ?? null,
          enc?.nonce ?? null,
          enc?.keyId ?? null,
          now,
        ],
      );
      await this.audit(c, id, actor, 'circle.join_requested');
      await this.saveIdem(c, actor, `join:${id}`, idem, {});
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async respondInvitation(
    actor: string,
    id: string,
    invitationId: string,
    action: 'accept' | 'decline',
    digest: string,
    key: string,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const snapshot = (
        await c.query(
          'SELECT c.owner_account_id,i.inviter_account_id FROM circles.circles c JOIN circles.invitations i ON i.circle_id=c.id WHERE c.id=$1 AND i.id=$2 AND i.invitee_account_id=$3',
          [id, invitationId, actor],
        )
      ).rows[0];
      if (!snapshot) throw new CircleNotFoundError();
      await this.pairLocks(c, actor, [snapshot.owner_account_id, snapshot.inviter_account_id]);
      const circle = (
        await c.query('SELECT owner_account_id FROM circles.circles WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      const invitation = (
        await c.query(
          'SELECT role,state,expires_at,inviter_account_id FROM circles.invitations WHERE id=$1 AND circle_id=$2 AND invitee_account_id=$3 FOR UPDATE',
          [invitationId, id, actor],
        )
      ).rows[0];
      if (
        !circle ||
        !invitation ||
        circle.owner_account_id !== snapshot.owner_account_id ||
        invitation.inviter_account_id !== snapshot.inviter_account_id
      )
        throw new CircleNotFoundError();
      // Expiry only normalizes a live generation.  A completed generation may
      // naturally pass its deadline, but its stored exact idempotency replay
      // remains part of the committed mutation contract.
      if (
        invitation.state === 'pending' &&
        new Date(invitation.expires_at).getTime() <= Date.now()
      ) {
        await c.query(
          "UPDATE circles.invitations SET state='expired',updated_at=now() WHERE id=$1 AND state='pending'",
          [invitationId],
        );
        await c.query(
          "UPDATE circles.notification_handoff SET state='cancelled',last_error='INVITATION_EXPIRED',updated_at=now() WHERE invitation_id=$1 AND state IN ('pending','retrying','leased')",
          [invitationId],
        );
        await c.query('COMMIT');
        throw new CircleNotFoundError();
      }
      const idem = await this.idem(
        c,
        actor,
        `invitation:${id}:${invitationId}:${action}`,
        key,
        digest,
      );
      if (action === 'accept') {
        const inviter = (
          await c.query(
            "SELECT role FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state='active' FOR UPDATE",
            [id, invitation.inviter_account_id],
          )
        ).rows[0];
        if (!inviter || !['owner', 'moderator'].includes(inviter.role))
          throw new CircleNotFoundError();
        await this.gateCheck(actor, id, 'admit', undefined, c, invitation.inviter_account_id);
      }
      if (idem.old) {
        await c.query('COMMIT');
        return;
      }
      if (invitation.state !== 'pending') throw new CircleNotFoundError();
      if (action === 'accept') {
        const circleOwner = (
          await c.query('SELECT owner_account_id FROM circles.circles WHERE id=$1', [id])
        ).rows[0]?.owner_account_id as string | undefined;
        if (!circleOwner) throw new CircleNotFoundError();
        await this.gateCheck(actor, id, 'admit', undefined, c, circleOwner);
      }
      if (action === 'accept') {
        const circle = (
          await c.query(
            "SELECT lifecycle,member_cap,(SELECT count(*) FROM circles.memberships m WHERE m.circle_id=circles.id AND m.state='active') AS count FROM circles.circles WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (
          !circle ||
          circle.lifecycle !== 'active' ||
          Number(circle.count) >= Number(circle.member_cap)
        )
          throw new CircleDomainError('CONFLICT');
        const existingMembership = await c.query(
          "SELECT 1 FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state IN ('active','pending') FOR UPDATE",
          [id, actor],
        );
        if (existingMembership.rowCount) throw new CircleDomainError('CONFLICT');
        await c.query(
          "INSERT INTO circles.memberships(id,circle_id,account_id,role,state,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())",
          [randomUUID(), id, actor, invitation.role],
        );
        await c.query(
          "UPDATE circles.invitations SET state='accepted',updated_at=now() WHERE id=$1",
          [invitationId],
        );
        await c.query(
          "UPDATE circles.notification_handoff SET state='cancelled',last_error='INVITATION_ACCEPTED',updated_at=now() WHERE invitation_id=$1 AND state IN ('pending','retrying','leased')",
          [invitationId],
        );
      } else {
        await c.query(
          "UPDATE circles.invitations SET state='declined',updated_at=now() WHERE id=$1",
          [invitationId],
        );
        await c.query(
          "UPDATE circles.notification_handoff SET state='cancelled',last_error='INVITATION_DECLINED',updated_at=now() WHERE invitation_id=$1 AND state IN ('pending','retrying','leased')",
          [invitationId],
        );
      }
      await c.query(
        'INSERT INTO circles.audit_events(circle_id,actor_account_id,subject_account_id,event_type,metadata,created_at) VALUES($1,$2,$2,$3,$4,now())',
        [id, actor, `circle.invitation_${action}`, JSON.stringify({ invitation_id: invitationId })],
      );
      await this.saveIdem(c, actor, `invitation:${id}:${invitationId}:${action}`, idem, {});
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async cancelInvitation(
    actor: string,
    id: string,
    invitationId: string,
    digest: string,
    key: string,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      await this.membership(c, actor, id, ['owner', 'moderator']);
      await this.gateCheck(actor, id, 'mutate', 'moderator', c);
      const idem = await this.idem(
        c,
        actor,
        `invitation-cancel:${id}:${invitationId}`,
        key,
        digest,
      );
      if (idem.old) {
        await c.query('COMMIT');
        return;
      }
      const invitation = (
        await c.query(
          "SELECT invitee_account_id FROM circles.invitations WHERE id=$1 AND circle_id=$2 AND state='pending' FOR UPDATE",
          [invitationId, id],
        )
      ).rows[0] as { invitee_account_id: string } | undefined;
      if (!invitation) throw new CircleNotFoundError();
      await c.query(
        "UPDATE circles.invitations SET state='cancelled',updated_at=now() WHERE id=$1",
        [invitationId],
      );
      await c.query(
        "UPDATE circles.notification_handoff SET state='cancelled',last_error='INVITATION_CANCELLED',updated_at=now() WHERE invitation_id=$1 AND state IN ('pending','retrying','leased')",
        [invitationId],
      );
      await this.audit(c, id, actor, 'circle.invitation_cancel', invitation.invitee_account_id, {
        invitation_id: invitationId,
      });
      await this.saveIdem(c, actor, `invitation-cancel:${id}:${invitationId}`, idem, {});
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async leave(actor: string, id: string, digest: string, key: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      const idem = await this.idem(c, actor, `leave:${id}`, key, digest);
      if (idem.old) {
        await c.query('COMMIT');
        return;
      }
      const m = await this.membership(c, actor, id, ['owner', 'moderator', 'member']);
      if (
        m.role === 'owner' &&
        (
          await c.query(
            "SELECT count(*) FROM circles.memberships WHERE circle_id=$1 AND role='owner' AND state='active'",
            [id],
          )
        ).rows[0].count <= 1
      )
        throw new CircleDomainError('CONFLICT');
      await c.query(
        "UPDATE circles.memberships SET state='left',updated_at=$3 WHERE circle_id=$1 AND account_id=$2 AND state='active'",
        [id, actor, new Date()],
      );
      await this.audit(c, id, actor, 'circle.left');
      await this.saveIdem(c, actor, `leave:${id}`, idem, {});
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async withdrawJoin(actor: string, id: string, digest: string, key: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      const idem = await this.idem(c, actor, `join-withdraw:${id}`, key, digest);
      if (idem.old) {
        await c.query('COMMIT');
        return;
      }
      const changed = await c.query(
        "UPDATE circles.memberships SET state='left',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='pending'",
        [id, actor],
      );
      if (!changed.rowCount) throw new CircleNotFoundError();
      await c.query(
        "UPDATE circles.join_requests SET state='cancelled',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='pending'",
        [id, actor],
      );
      await this.audit(c, id, actor, 'circle.join_withdrawn');
      await this.saveIdem(c, actor, `join-withdraw:${id}`, idem, {});
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async memberAction(
    actor: string,
    id: string,
    memberId: string,
    action: any,
    role: any,
    digest: string,
    key: string,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await this.pairLock(c, actor, memberId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      const actorMembership = await this.membership(c, actor, id);
      // A promotion creates fresh cross-account governance authority and must
      // therefore pass the subject gate.  Demotion/removal/decline are cleanup
      // paths: a blocked or revoked target must not be able to strand a circle.
      const targetMembership =
        action === 'role'
          ? (
              await c.query(
                "SELECT role FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state='active' FOR UPDATE",
                [id, memberId],
              )
            ).rows[0]
          : undefined;
      if (action === 'role' && !targetMembership) throw new CircleNotFoundError();
      const rank: Record<CircleRole, number> = { member: 0, moderator: 1, owner: 2 };
      const subjectRequiresGate =
        action === 'approve' ||
        (action === 'role' &&
          !!role &&
          rank[role as CircleRole] > rank[targetMembership.role as CircleRole]);
      await this.gateCheck(
        actor,
        id,
        action === 'approve' ? 'admit' : 'mutate',
        action === 'role' ? 'owner' : 'moderator',
        c,
        subjectRequiresGate ? memberId : undefined,
      );
      const idem = await this.idem(c, actor, `${action}:${id}:${memberId}`, key, digest);
      if (idem.old) {
        await c.query('COMMIT');
        return;
      }
      if (action === 'approve') {
        const cap = (
          await c.query(
            "SELECT c.member_cap,(SELECT count(*) FROM circles.memberships m WHERE m.circle_id=c.id AND m.state='active') AS count FROM circles.circles c WHERE c.id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!cap || Number(cap.count) >= Number(cap.member_cap))
          throw new CircleDomainError('CONFLICT');
        const changed = await c.query(
          "UPDATE circles.memberships SET state='active',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='pending'",
          [id, memberId],
        );
        if (!changed.rowCount) throw new CircleNotFoundError();
        await c.query(
          "UPDATE circles.join_requests SET state='approved',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='pending'",
          [id, memberId],
        );
      } else if (action === 'decline') {
        const changed = await c.query(
          "UPDATE circles.memberships SET state='rejected',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='pending'",
          [id, memberId],
        );
        if (!changed.rowCount) throw new CircleNotFoundError();
        await c.query(
          "UPDATE circles.join_requests SET state='rejected',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='pending'",
          [id, memberId],
        );
      } else if (action === 'remove') {
        const target = (
          await c.query(
            "SELECT role FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state='active' FOR UPDATE",
            [id, memberId],
          )
        ).rows[0];
        if (target?.role === 'owner') throw new CircleDomainError('CONFLICT');
        const changed = await c.query(
          "UPDATE circles.memberships SET state='removed',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='active'",
          [id, memberId],
        );
        if (!changed.rowCount) throw new CircleNotFoundError();
      } else {
        if (memberId === actor && role !== 'owner') throw new CircleDomainError('CONFLICT');
        if (role === 'owner') {
          if (actorMembership.role !== 'owner') throw new CircleDomainError('CONFLICT');
          // Transfer is a single-circle-lock transaction: exactly one current
          // owner membership and the authoritative pointer move together.
          await c.query(
            "UPDATE circles.memberships SET role='moderator',updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='active' AND role='owner'",
            [id, actor],
          );
          await c.query(
            'UPDATE circles.circles SET owner_account_id=$2,updated_at=now() WHERE id=$1',
            [id, memberId],
          );
        }
        const changed = await c.query(
          "UPDATE circles.memberships SET role=$3,updated_at=now() WHERE circle_id=$1 AND account_id=$2 AND state='active'",
          [id, memberId, role],
        );
        if (!changed.rowCount) throw new CircleNotFoundError();
      }
      await this.audit(c, id, actor, `circle.member_${action}`, memberId, {
        ...(role ? { role } : {}),
      });
      await this.saveIdem(c, actor, `${action}:${id}:${memberId}`, idem, {});
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async addNote(actor: string, id: string, body: string, digest: string, key: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`circle:${id}`]);
      await this.membership(c, actor, id, ['owner', 'moderator', 'member']);
      await this.gateCheck(actor, id, 'mutate', undefined, c);
      const idem = await this.idem(c, actor, `note:${id}`, key, digest);
      if (idem.old) {
        const stored = await c.query(
          'SELECT body_ciphertext,body_nonce,body_key_id FROM circles.notes WHERE id=$1 AND circle_id=$2',
          [idem.old.result_json.id, id],
        );
        const body = stored.rows[0] ? this.decipher(stored.rows[0], 'body') : undefined;
        await c.query('COMMIT');
        return { ...idem.old.result_json, ...(body === undefined ? {} : { body }) };
      }
      const enc = this.cipher(body);
      const noteId = randomUUID();
      // The membership visibility boundary is also recorded by PostgreSQL.
      // Use the same clock authority here so a small host/container clock skew
      // cannot make a note created before removal look newer than the removal.
      const inserted = await c.query(
        'INSERT INTO circles.notes(id,circle_id,author_account_id,body_ciphertext,body_nonce,body_key_id,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING created_at',
        [noteId, id, actor, enc.ciphertext, enc.nonce, enc.keyId],
      );
      const note = {
        id: noteId,
        circle_id: id,
        author_account_id: actor,
        created_at: new Date(inserted.rows[0].created_at).toISOString(),
      };
      await this.audit(c, id, actor, 'circle.note_created');
      await this.saveIdem(c, actor, `note:${id}`, idem, note);
      await c.query('COMMIT');
      return { ...note, body };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async listNotes(actor: string, id: string, input: { limit: number; cursor?: string }) {
    const filter = `notes:${id}`;
    const cur = input.cursor
      ? this.decodeCursor(input.cursor, actor, 'circle-notes', filter)
      : undefined;
    const rows = await this.pool.query(
      "SELECT n.id,n.circle_id,n.author_account_id,n.created_at FROM circles.notes n JOIN circles.memberships m ON m.circle_id=n.circle_id AND m.account_id=$1 AND m.state='active' WHERE n.circle_id=$2 AND ($3::timestamptz IS NULL OR (n.created_at,n.id)>($3,$4::uuid)) ORDER BY n.created_at,n.id LIMIT $5",
      [actor, id, cur?.u ?? null, cur?.i ?? null, Math.max(input.limit * 10, 100)],
    );
    const items: Array<{
      id: string;
      circle_id: string;
      author_account_id: string;
      body: string;
      created_at: string;
    }> = [];
    let scanned = 0;
    for (const r of rows.rows) {
      scanned += 1;
      const visible = await this.gate.check({
        actorAccountId: actor,
        circleId: id,
        subjectAccountId: r.author_account_id,
        operation: 'read',
      });
      if (visible.allowed) {
        const full = await this.pool.query(
          'SELECT body_ciphertext,body_nonce,body_key_id FROM circles.notes WHERE id=$1',
          [r.id],
        );
        const body = full.rows[0] ? this.decipher(full.rows[0], 'body') : undefined;
        const finalVisible = await this.gate.check({
          actorAccountId: actor,
          circleId: id,
          subjectAccountId: r.author_account_id,
          operation: 'read',
        });
        if (body !== undefined && finalVisible.allowed)
          items.push({
            id: r.id,
            circle_id: r.circle_id,
            author_account_id: r.author_account_id,
            body,
            created_at: new Date(r.created_at).toISOString(),
          });
      }
      if (items.length >= input.limit) break;
    }
    const last = rows.rows[scanned - 1];
    return circleNotesSchema.parse({
      items,
      next_cursor:
        last && (scanned < rows.rows.length || rows.rows.length >= Math.max(input.limit * 10, 100))
          ? this.cursor(
              actor,
              'circle-notes',
              filter,
              new Date(last.created_at).toISOString(),
              last.id,
            )
          : null,
    });
  }

  async listMembers(actor: string, id: string, input: { limit: number; cursor?: string }) {
    const filter = `members:${id}`;
    const cur = input.cursor
      ? this.decodeCursor(input.cursor, actor, 'circle-members', filter)
      : undefined;
    const rows = await this.pool.query(
      "SELECT m.account_id,m.role,m.updated_at FROM circles.memberships m WHERE m.circle_id=$1 AND m.state='active' AND ($2::timestamptz IS NULL OR (m.updated_at,m.account_id)<($2,$3::uuid)) ORDER BY m.updated_at DESC,m.account_id DESC LIMIT $4",
      [id, cur?.u ?? null, cur?.i ?? null, Math.max(input.limit * 10, 100)],
    );
    const items: Array<{ account_id: string; role: CircleRole; created_at: string }> = [];
    let scanned = 0;
    for (const row of rows.rows) {
      scanned += 1;
      const visible = await this.gate.check({
        actorAccountId: actor,
        circleId: id,
        subjectAccountId: row.account_id,
        operation: 'read',
      });
      const finalVisible = visible.allowed
        ? await this.gate.check({
            actorAccountId: actor,
            circleId: id,
            subjectAccountId: row.account_id,
            operation: 'read',
          })
        : undefined;
      if (finalVisible?.allowed)
        items.push({
          account_id: row.account_id,
          role: row.role,
          created_at: new Date(row.updated_at).toISOString(),
        });
      if (items.length >= input.limit) break;
    }
    const last = rows.rows[scanned - 1];
    return circleMembersSchema.parse({
      items,
      next_cursor:
        last && (scanned < rows.rows.length || rows.rows.length >= Math.max(input.limit * 10, 100))
          ? this.cursor(
              actor,
              'circle-members',
              filter,
              new Date(last.updated_at).toISOString(),
              last.account_id,
            )
          : null,
    });
  }

  async listJoinRequests(actor: string, id: string, input: { limit: number; cursor?: string }) {
    const filter = `join-requests:${id}`;
    const cur = input.cursor
      ? this.decodeCursor(input.cursor, actor, 'circle-join-requests', filter)
      : undefined;
    const rows = await this.pool.query(
      "SELECT j.id,j.account_id,j.message_ciphertext,j.message_nonce,j.message_key_id,j.created_at FROM circles.join_requests j WHERE j.circle_id=$1 AND j.state='pending' AND ($2::timestamptz IS NULL OR (j.created_at,j.id)<($2,$3::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT $4",
      [id, cur?.u ?? null, cur?.i ?? null, Math.max(input.limit * 10, 100)],
    );
    const items: Array<{
      id: string;
      account_id: string;
      message: string | null;
      created_at: string;
    }> = [];
    let scanned = 0;
    for (const row of rows.rows) {
      scanned += 1;
      const visible = await this.gate.check({
        actorAccountId: actor,
        circleId: id,
        subjectAccountId: row.account_id,
        // Pending applicants are not active members yet. Reuse the existing
        // admission gate (with a moderator role requirement) so their current
        // IAM/VER/ELG/SAF pair is still checked without pretending membership.
        operation: 'admit',
        requiredRole: 'moderator',
      });
      if (visible.allowed) {
        const message = this.decipher(row, 'message') ?? null;
        // Recheck immediately before response projection so a pair block or
        // eligibility revocation during decryption cannot escape the list.
        const finalVisible = await this.gate.check({
          actorAccountId: actor,
          circleId: id,
          subjectAccountId: row.account_id,
          operation: 'admit',
          requiredRole: 'moderator',
        });
        if (finalVisible.allowed)
          items.push({
            id: row.id,
            account_id: row.account_id,
            message,
            created_at: new Date(row.created_at).toISOString(),
          });
      }
      if (items.length >= input.limit) break;
    }
    const last = rows.rows[scanned - 1];
    return circleJoinRequestsSchema.parse({
      items,
      next_cursor:
        last && (scanned < rows.rows.length || rows.rows.length >= Math.max(input.limit * 10, 100))
          ? this.cursor(
              actor,
              'circle-join-requests',
              filter,
              new Date(last.created_at).toISOString(),
              last.id,
            )
          : null,
    });
  }

  /** Safety escape path: it intentionally does not invoke the live GrowthGate
   * because a block/revocation must not erase a participant's reporting
   * ability. It returns immutable identifiers/state only, never ciphertext or
   * plaintext. */
  async reportableEvidence(
    actor: string,
    targetType: 'circle' | 'note',
    targetId: string,
    circleId?: string,
  ) {
    if (targetType === 'circle') {
      const row = (
        await this.pool.query(
          'SELECT c.owner_account_id,c.lifecycle,c.updated_at FROM circles.circles c WHERE c.id=$1 AND EXISTS (SELECT 1 FROM circles.memberships m WHERE m.circle_id=c.id AND m.account_id=$2)',
          [targetId, actor],
        )
      ).rows[0];
      return row
        ? {
            subjectAccountId: row.owner_account_id as string,
            sourceVersion: new Date(row.updated_at).toISOString(),
            lifecycle: row.lifecycle as 'draft' | 'active' | 'archived',
          }
        : null;
    }
    const row = (
      await this.pool.query(
        "SELECT n.author_account_id,n.created_at FROM circles.notes n WHERE n.id=$1 AND ($3::uuid IS NULL OR n.circle_id=$3::uuid) AND EXISTS (SELECT 1 FROM circles.memberships m WHERE m.circle_id=n.circle_id AND m.account_id=$2 AND (m.state='active' OR (m.state IN ('left','removed') AND n.created_at<=m.updated_at)))",
        [targetId, actor, circleId ?? null],
      )
    ).rows[0];
    return row
      ? {
          subjectAccountId: row.author_account_id as string,
          sourceVersion: new Date(row.created_at).toISOString(),
          moderationState: 'visible' as const,
        }
      : null;
  }
}
