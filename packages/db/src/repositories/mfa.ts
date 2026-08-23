import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { mfaChallenges, mfaFactors, recoveryCodes } from '../schema.js';

export type MfaFactorState = 'pending' | 'enabled' | 'disabled';
export type MfaChallengeState = 'pending' | 'consumed' | 'expired' | 'revoked';
/** R1-06A: the authentication methods a challenge accepts, fixed at issuance. */
export type MfaMethod = 'totp' | 'recovery';

export interface MfaFactorRow {
  id: string;
  accountId: string;
  type: 'totp';
  state: MfaFactorState;
  secretCiphertext: string;
  secretNonce: string;
  secretKeyId: string;
  createdAt: Date;
  verifiedAt: Date | null;
  enabledAt: Date | null;
  disabledAt: Date | null;
}

export interface MfaChallengeRow {
  id: string;
  accountId: string;
  digest: string;
  state: MfaChallengeState;
  attemptCount: number;
  maxAttempts: number;
  expiresAt: Date;
  /** R1-06A: the device that passed the password step — completion requires this exact row. */
  deviceId: string | null;
  /** R1-06A: methods accepted by this challenge, fixed at issuance. */
  methodSet: MfaMethod[];
  consumedAt: Date | null;
  createdAt: Date;
}

export interface RecoveryCodeRow {
  id: string;
  factorId: string;
  accountId: string;
  codeDigest: string;
  createdAt: Date;
  usedAt: Date | null;
}

export interface NewMfaFactor {
  id: string;
  accountId: string;
  secretCiphertext: string;
  secretNonce: string;
  secretKeyId: string;
  now: Date;
}

export interface NewMfaChallenge {
  id: string;
  accountId: string;
  digest: string;
  expiresAt: Date;
  maxAttempts: number;
  /** R1-06A: device binding — the row that passed the password step. */
  deviceId: string | null;
  /** R1-06A: totp always; recovery only while unused codes exist. */
  methodSet: MfaMethod[];
  now: Date;
}

/**
 * R1-04: the partial unique index rejected the insert — an account already
 * holds a pending or enabled factor. The service maps this to a stable 409.
 */
export class FactorSlotTakenError extends Error {
  constructor() {
    super('an active MFA factor already exists for this account');
    this.name = 'FactorSlotTakenError';
  }
}

export interface MfaRepository {
  insertFactor(input: NewMfaFactor): Promise<MfaFactorRow>;
  /** R1-04: the enrollment transaction inserts on the LOCKED account row — must run on tx. */
  insertFactorTx(tx: Db, input: NewMfaFactor): Promise<MfaFactorRow>;
  findFactorById(accountId: string, factorId: string): Promise<MfaFactorRow | null>;
  listFactorsByAccount(accountId: string): Promise<MfaFactorRow[]>;
  /** R1-04: pending + enabled — both occupy the unique slot; disabled does not. */
  listActiveFactorsByAccount(accountId: string): Promise<MfaFactorRow[]>;
  /** R1-04: same, inside the enrollment transaction (reads the locked account's slot). */
  listActiveFactorsByAccountTx(tx: Db, accountId: string): Promise<MfaFactorRow[]>;
  /** Latest PENDING factor of the account — the target of enrollment confirm. */
  findPendingByAccount(accountId: string): Promise<MfaFactorRow | null>;
  setFactorEnabled(factorId: string, now: Date): Promise<MfaFactorRow | null>;
  setFactorDisabled(factorId: string, now: Date): Promise<MfaFactorRow | null>;
  /** Tx-scoped gate: pending → enabled; a concurrent confirm loses (null). */
  setFactorEnabledTx(tx: Db, factorId: string, now: Date): Promise<MfaFactorRow | null>;
  setFactorDisabledTx(tx: Db, factorId: string, now: Date): Promise<MfaFactorRow | null>;
  insertChallenge(input: NewMfaChallenge): Promise<MfaChallengeRow>;
  findChallengeByDigest(digest: string): Promise<MfaChallengeRow | null>;
  /** Atomically consume a pending challenge; returns false when not pending. */
  consumeChallenge(tx: Db, challengeId: string, now: Date): Promise<boolean>;
  /**
   * R1-05: atomic CAPPED attempt accounting. Only a PENDING challenge with
   * budget left increments; the miss that exhausts the budget flips the state
   * to expired in the same statement. Returns 'recorded' (budget left),
   * 'exhausted' (this miss hit the cap) or 'terminal' (not pending or already
   * at the cap — nothing was counted).
   */
  recordChallengeAttempt(
    tx: Db,
    challengeId: string,
    maxAttempts: number,
  ): Promise<'recorded' | 'exhausted' | 'terminal'>;
  /** R1-06A: unused recovery codes left for the account (method-set building). */
  countUnusedRecoveryCodesByAccount(accountId: string): Promise<number>;
  /** Flip pending challenges whose expiry has passed. */
  expirePendingBefore(now: Date): Promise<number>;
  insertRecoveryCodes(
    factorId: string,
    accountId: string,
    codes: Array<{ id: string; digest: string }>,
    now: Date,
  ): Promise<void>;
  insertRecoveryCodesTx(
    tx: Db,
    factorId: string,
    accountId: string,
    codes: Array<{ id: string; digest: string }>,
    now: Date,
  ): Promise<void>;
  /** Atomically consume one unused recovery code (UPDATE ... WHERE used_at IS NULL). */
  consumeRecoveryCode(tx: Db, codeDigest: string, now: Date): Promise<boolean>;
  /** Single-shot read of an unused recovery code without consuming it. */
  findUnusedRecoveryCode(codeDigest: string): Promise<RecoveryCodeRow | null>;
  /** Regenerate/disable: remove all unused codes of the factor. */
  deleteUnusedByFactor(factorId: string): Promise<number>;
  deleteUnusedByFactorTx(tx: Db, factorId: string): Promise<number>;
}

export class PgMfaRepository implements MfaRepository {
  constructor(private readonly db: Db) {}

  async insertFactor(input: NewMfaFactor): Promise<MfaFactorRow> {
    return this.insertFactorTx(this.db, input);
  }

  async insertFactorTx(tx: Db, input: NewMfaFactor): Promise<MfaFactorRow> {
    try {
      const rows = await tx
        .insert(mfaFactors)
        .values({
          id: input.id,
          accountId: input.accountId,
          type: 'totp',
          state: 'pending',
          secretCiphertext: input.secretCiphertext,
          secretNonce: input.secretNonce,
          secretKeyId: input.secretKeyId,
          createdAt: input.now,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error('insert mfa factor returned no row');
      }
      return row as unknown as MfaFactorRow;
    } catch (error) {
      // R1-04: the partial unique index is the race backstop — a concurrent
      // start/confirm already occupies the slot. Surface a domain signal
      // instead of leaking the pg error (which would 500).
      const pgError = error as { code?: string; constraint?: string };
      if (pgError.code === '23505' && pgError.constraint === 'mfa_factors_active_unique_idx') {
        throw new FactorSlotTakenError();
      }
      throw error;
    }
  }

  async findFactorById(accountId: string, factorId: string): Promise<MfaFactorRow | null> {
    const rows = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(mfaFactors.accountId, accountId), eq(mfaFactors.id, factorId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as MfaFactorRow);
  }

  async listFactorsByAccount(accountId: string): Promise<MfaFactorRow[]> {
    const rows = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(mfaFactors.accountId, accountId), eq(mfaFactors.state, 'enabled')))
      .orderBy(desc(mfaFactors.createdAt));
    return rows as unknown as MfaFactorRow[];
  }

  async listActiveFactorsByAccount(accountId: string): Promise<MfaFactorRow[]> {
    return this.listActiveFactorsByAccountTx(this.db, accountId);
  }

  async listActiveFactorsByAccountTx(tx: Db, accountId: string): Promise<MfaFactorRow[]> {
    const rows = await tx
      .select()
      .from(mfaFactors)
      .where(
        and(eq(mfaFactors.accountId, accountId), inArray(mfaFactors.state, ['pending', 'enabled'])),
      )
      .orderBy(desc(mfaFactors.createdAt));
    return rows as unknown as MfaFactorRow[];
  }

  async findPendingByAccount(accountId: string): Promise<MfaFactorRow | null> {
    const rows = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(mfaFactors.accountId, accountId), eq(mfaFactors.state, 'pending')))
      .orderBy(desc(mfaFactors.createdAt))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as MfaFactorRow);
  }

  async setFactorEnabled(factorId: string, now: Date): Promise<MfaFactorRow | null> {
    const rows = await this.db
      .update(mfaFactors)
      .set({ state: 'enabled', verifiedAt: now, enabledAt: now })
      .where(and(eq(mfaFactors.id, factorId), eq(mfaFactors.state, 'pending')))
      .returning();
    const row = rows[0];
    return row === undefined ? null : (row as unknown as MfaFactorRow);
  }

  async setFactorDisabled(factorId: string, now: Date): Promise<MfaFactorRow | null> {
    const rows = await this.db
      .update(mfaFactors)
      .set({ state: 'disabled', disabledAt: now })
      .where(eq(mfaFactors.id, factorId))
      .returning();
    const row = rows[0];
    return row === undefined ? null : (row as unknown as MfaFactorRow);
  }

  async setFactorEnabledTx(tx: Db, factorId: string, now: Date): Promise<MfaFactorRow | null> {
    const rows = await tx
      .update(mfaFactors)
      .set({ state: 'enabled', verifiedAt: now, enabledAt: now })
      .where(and(eq(mfaFactors.id, factorId), eq(mfaFactors.state, 'pending')))
      .returning();
    const row = rows[0];
    return row === undefined ? null : (row as unknown as MfaFactorRow);
  }

  async setFactorDisabledTx(tx: Db, factorId: string, now: Date): Promise<MfaFactorRow | null> {
    const rows = await tx
      .update(mfaFactors)
      .set({ state: 'disabled', disabledAt: now })
      .where(eq(mfaFactors.id, factorId))
      .returning();
    const row = rows[0];
    return row === undefined ? null : (row as unknown as MfaFactorRow);
  }

  async insertChallenge(input: NewMfaChallenge): Promise<MfaChallengeRow> {
    const rows = await this.db
      .insert(mfaChallenges)
      .values({
        id: input.id,
        accountId: input.accountId,
        digest: input.digest,
        state: 'pending',
        attemptCount: 0,
        maxAttempts: input.maxAttempts,
        deviceId: input.deviceId,
        methodSet: input.methodSet,
        expiresAt: input.expiresAt,
        createdAt: input.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('insert mfa challenge returned no row');
    }
    return row as unknown as MfaChallengeRow;
  }

  async findChallengeByDigest(digest: string): Promise<MfaChallengeRow | null> {
    const rows = await this.db
      .select()
      .from(mfaChallenges)
      .where(eq(mfaChallenges.digest, digest))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as MfaChallengeRow);
  }

  async consumeChallenge(tx: Db, challengeId: string, now: Date): Promise<boolean> {
    const result = await tx
      .update(mfaChallenges)
      .set({ state: 'consumed', consumedAt: now })
      .where(and(eq(mfaChallenges.id, challengeId), eq(mfaChallenges.state, 'pending')));
    return (result.rowCount ?? 0) === 1;
  }

  async recordChallengeAttempt(
    tx: Db,
    challengeId: string,
    maxAttempts: number,
  ): Promise<'recorded' | 'exhausted' | 'terminal'> {
    const rows = await tx
      .update(mfaChallenges)
      .set({
        attemptCount: sql`${mfaChallenges.attemptCount} + 1`,
        state: sql`CASE WHEN ${mfaChallenges.attemptCount} + 1 >= ${maxAttempts} THEN 'expired' ELSE ${mfaChallenges.state} END`,
      })
      .where(
        and(
          eq(mfaChallenges.id, challengeId),
          eq(mfaChallenges.state, 'pending'),
          lt(mfaChallenges.attemptCount, maxAttempts),
        ),
      )
      .returning({ state: mfaChallenges.state });
    const row = rows[0];
    if (row === undefined) {
      // Not pending or already at the cap — nothing counted, nothing changed.
      return 'terminal';
    }
    return row.state === 'expired' ? 'exhausted' : 'recorded';
  }

  async countUnusedRecoveryCodesByAccount(accountId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.accountId, accountId), isNull(recoveryCodes.usedAt)));
    return rows[0]?.count ?? 0;
  }

  async expirePendingBefore(now: Date): Promise<number> {
    const result = await this.db
      .update(mfaChallenges)
      .set({ state: 'expired' })
      .where(and(eq(mfaChallenges.state, 'pending'), lt(mfaChallenges.expiresAt, now)));
    return result.rowCount ?? 0;
  }

  async insertRecoveryCodes(
    factorId: string,
    accountId: string,
    codes: Array<{ id: string; digest: string }>,
    now: Date,
  ): Promise<void> {
    await this.insertRecoveryCodesTx(this.db, factorId, accountId, codes, now);
  }

  async insertRecoveryCodesTx(
    tx: Db,
    factorId: string,
    accountId: string,
    codes: Array<{ id: string; digest: string }>,
    now: Date,
  ): Promise<void> {
    if (codes.length === 0) {
      return;
    }
    await tx.insert(recoveryCodes).values(
      codes.map((code) => ({
        id: code.id,
        factorId,
        accountId,
        codeDigest: code.digest,
        createdAt: now,
      })),
    );
  }

  async consumeRecoveryCode(tx: Db, codeDigest: string, now: Date): Promise<boolean> {
    const result = await tx
      .update(recoveryCodes)
      .set({ usedAt: now })
      .where(and(eq(recoveryCodes.codeDigest, codeDigest), isNull(recoveryCodes.usedAt)));
    return (result.rowCount ?? 0) === 1;
  }

  async findUnusedRecoveryCode(codeDigest: string): Promise<RecoveryCodeRow | null> {
    const rows = await this.db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.codeDigest, codeDigest), isNull(recoveryCodes.usedAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as RecoveryCodeRow);
  }

  async deleteUnusedByFactor(factorId: string): Promise<number> {
    return this.deleteUnusedByFactorTx(this.db, factorId);
  }

  async deleteUnusedByFactorTx(tx: Db, factorId: string): Promise<number> {
    const result = await tx
      .delete(recoveryCodes)
      .where(and(eq(recoveryCodes.factorId, factorId), isNull(recoveryCodes.usedAt)));
    return result.rowCount ?? 0;
  }
}
