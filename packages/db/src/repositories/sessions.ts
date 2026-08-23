import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { sessions } from '../schema.js';

export type SessionState = 'active' | 'rotated' | 'revoked' | 'compromised';
export type AuthLevel = 'aal1' | 'aal2';

export interface SessionRow {
  id: string;
  accountId: string;
  deviceId: string | null;
  familyId: string;
  parentId: string | null;
  successorId: string | null;
  tokenDigest: string;
  generation: number;
  state: SessionState;
  authLevel: AuthLevel;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface NewSession {
  id: string;
  accountId: string;
  deviceId: string | null;
  familyId: string;
  parentId: string | null;
  tokenDigest: string;
  generation: number;
  authLevel: AuthLevel;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface SessionRepository {
  insert(input: NewSession): Promise<SessionRow>;
  findByTokenDigest(tokenDigest: string): Promise<SessionRow | null>;
  findById(id: string): Promise<SessionRow | null>;
  /** Active (non-rotated/revoked/compromised) sessions of an account, newest first. */
  listActiveByAccount(accountId: string): Promise<SessionRow[]>;
  /** Same, inside a transaction (MFA strength changes revoke the account's other sessions). */
  listActiveByAccountTx(tx: Db, accountId: string): Promise<SessionRow[]>;
  /** Locked read for rotate/revoke decisions inside a transaction (SELECT ... FOR UPDATE). */
  findByIdForUpdate(tx: Db, id: string): Promise<SessionRow | null>;
  /** Locked read by token digest (task book §6.2: the rotate tx locks the presented token). */
  findByTokenDigestForUpdate(tx: Db, tokenDigest: string): Promise<SessionRow | null>;
  /** Mark a session rotated (old generation) and insert its successor — same family, generation+1. */
  rotate(input: {
    tx: Db;
    sessionId: string;
    successor: NewSession;
    now: Date;
  }): Promise<{ rotated: SessionRow; successor: SessionRow }>;
  revokeById(tx: Db, id: string, reason: string, now: Date): Promise<SessionRow | null>;
  revokeMany(tx: Db, ids: string[], reason: string, now: Date): Promise<number>;
  revokeByAccount(tx: Db, accountId: string, reason: string, now: Date): Promise<number>;
  revokeByDevice(tx: Db, deviceId: string, reason: string, now: Date): Promise<number>;
  /**
   * Activity refresh (R1-03): extends last_seen/idle only for a session that
   * is STILL active and unexpired — never re-activates a revoked/rotated/
   * expired session. Returns the number of rows updated (0 = died concurrently).
   */
  touchActive(tx: Db, id: string, now: Date, idleExpiresAt: Date): Promise<number>;
  setCompromised(tx: Db, familyId: string, now: Date): Promise<number>;
}

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  async insert(input: NewSession): Promise<SessionRow> {
    const rows = await this.db
      .insert(sessions)
      .values({
        id: input.id,
        accountId: input.accountId,
        deviceId: input.deviceId,
        familyId: input.familyId,
        parentId: input.parentId,
        tokenDigest: input.tokenDigest,
        generation: input.generation,
        state: 'active',
        authLevel: input.authLevel,
        createdAt: input.createdAt,
        lastSeenAt: input.createdAt,
        idleExpiresAt: input.idleExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('insert session returned no row');
    }
    return row as unknown as SessionRow;
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRow | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenDigest, tokenDigest))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as SessionRow);
  }

  async findById(id: string): Promise<SessionRow | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as SessionRow);
  }

  async listActiveByAccount(accountId: string): Promise<SessionRow[]> {
    return this.listActiveByAccountTx(this.db, accountId);
  }

  async listActiveByAccountTx(tx: Db, accountId: string): Promise<SessionRow[]> {
    const rows = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.accountId, accountId), eq(sessions.state, 'active')))
      .orderBy(desc(sessions.createdAt));
    return rows as unknown as SessionRow[];
  }

  async findByIdForUpdate(tx: Db, id: string): Promise<SessionRow | null> {
    const rows = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update').limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as SessionRow);
  }

  async findByTokenDigestForUpdate(tx: Db, tokenDigest: string): Promise<SessionRow | null> {
    const rows = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.tokenDigest, tokenDigest))
      .for('update')
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as SessionRow);
  }

  async rotate(input: {
    tx: Db;
    sessionId: string;
    successor: NewSession;
    now: Date;
  }): Promise<{ rotated: SessionRow; successor: SessionRow }> {
    const rotatedRows = await input.tx
      .update(sessions)
      .set({
        state: 'rotated',
        rotatedAt: input.now,
        successorId: input.successor.id,
      })
      .where(eq(sessions.id, input.sessionId))
      .returning();
    const rotated = rotatedRows[0];
    if (rotated === undefined) {
      throw new Error('rotate: session to rotate not found');
    }
    const successorRows = await input.tx
      .insert(sessions)
      .values({
        id: input.successor.id,
        accountId: input.successor.accountId,
        deviceId: input.successor.deviceId,
        familyId: input.successor.familyId,
        parentId: input.successor.parentId,
        tokenDigest: input.successor.tokenDigest,
        generation: input.successor.generation,
        state: 'active',
        authLevel: input.successor.authLevel,
        createdAt: input.successor.createdAt,
        lastSeenAt: input.successor.createdAt,
        idleExpiresAt: input.successor.idleExpiresAt,
        absoluteExpiresAt: input.successor.absoluteExpiresAt,
      })
      .returning();
    const successor = successorRows[0];
    if (successor === undefined) {
      throw new Error('rotate: successor insert returned no row');
    }
    return {
      rotated: rotated as unknown as SessionRow,
      successor: successor as unknown as SessionRow,
    };
  }

  async revokeById(tx: Db, id: string, reason: string, now: Date): Promise<SessionRow | null> {
    const rows = await tx
      .update(sessions)
      .set({ state: 'revoked', revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.id, id), eq(sessions.state, 'active')))
      .returning();
    const row = rows[0];
    return row === undefined ? null : (row as unknown as SessionRow);
  }

  async revokeMany(tx: Db, ids: string[], reason: string, now: Date): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await tx
      .update(sessions)
      .set({ state: 'revoked', revokedAt: now, revokedReason: reason })
      .where(and(inArray(sessions.id, ids), eq(sessions.state, 'active')));
    return result.rowCount ?? 0;
  }

  async revokeByAccount(tx: Db, accountId: string, reason: string, now: Date): Promise<number> {
    const result = await tx
      .update(sessions)
      .set({ state: 'revoked', revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.accountId, accountId), eq(sessions.state, 'active')));
    return result.rowCount ?? 0;
  }

  async revokeByDevice(tx: Db, deviceId: string, reason: string, now: Date): Promise<number> {
    const result = await tx
      .update(sessions)
      .set({ state: 'revoked', revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.deviceId, deviceId), eq(sessions.state, 'active')));
    return result.rowCount ?? 0;
  }

  async touchActive(tx: Db, id: string, now: Date, idleExpiresAt: Date): Promise<number> {
    const result = await tx
      .update(sessions)
      .set({ lastSeenAt: now, idleExpiresAt })
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.state, 'active'),
          gt(sessions.idleExpiresAt, now),
          gt(sessions.absoluteExpiresAt, now),
        ),
      );
    return result.rowCount ?? 0;
  }

  async setCompromised(tx: Db, familyId: string, now: Date): Promise<number> {
    const result = await tx
      .update(sessions)
      .set({ state: 'compromised', revokedAt: now, revokedReason: 'replay_detected' })
      .where(and(eq(sessions.familyId, familyId), eq(sessions.state, 'active')));
    return result.rowCount ?? 0;
  }
}
