import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { accountStateTransitions, accounts, passwordCredentials } from '../schema.js';

export type AccountState = 'enabled' | 'suspended' | 'deletion_pending' | 'deleted';
export type StateActorType = 'system' | 'admin' | 'user';

export interface AccountRow {
  id: string;
  emailDigest: string | null;
  emailCiphertext: string;
  emailNonce: string;
  emailKeyId: string;
  state: AccountState;
  stateReason: string;
  stateActorType: StateActorType;
  stateActorId: string | null;
  stateChangedAt: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface NewAccount {
  id: string;
  emailDigest: string;
  emailCiphertext: string;
  emailNonce: string;
  emailKeyId: string;
  /** R1-06C: the request that created the account — stamped on the initial transition. */
  requestId: string;
  now: Date;
}

export interface AccountRepository {
  insert(input: NewAccount): Promise<AccountRow>;
  /**
   * Account + password credential in ONE transaction — a registration can
   * never leave an orphan account (email digest already taken) behind. A
   * unique-violation (duplicate email digest) rolls the whole insert back.
   */
  insertWithPassword(input: NewAccount, passwordHash: string, now: Date): Promise<AccountRow>;
  findByEmailDigest(emailDigest: string): Promise<AccountRow | null>;
  findById(id: string): Promise<AccountRow | null>;
  /**
   * State transition in one transaction: updates the row, bumps version,
   * appends the audit row. R1-06C: the request id is mandatory — every
   * transition row is correlated to the request that produced it.
   */
  transitionState(input: {
    accountId: string;
    fromState: AccountState;
    toState: AccountState;
    reason: string;
    actorType: StateActorType;
    actorId: string | null;
    requestId: string;
    now: Date;
  }): Promise<AccountRow | null>;
  /** Locked read for transition decisions inside a transaction (SELECT ... FOR UPDATE). */
  findByIdForUpdate(tx: Db, id: string): Promise<AccountRow | null>;
}

export class PgAccountRepository implements AccountRepository {
  constructor(private readonly db: Db) {}

  async insert(input: NewAccount): Promise<AccountRow> {
    return await this.db.transaction((tx) => this.insertAccountRow(tx, input, input.now));
  }

  async insertWithPassword(
    input: NewAccount,
    passwordHash: string,
    now: Date,
  ): Promise<AccountRow> {
    return await this.db.transaction(async (tx) => {
      const row = await this.insertAccountRow(tx, input, now);
      await tx.insert(passwordCredentials).values({
        accountId: row.id,
        hash: passwordHash,
        hashVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      return row;
    });
  }

  private async insertAccountRow(tx: Db, input: NewAccount, now: Date): Promise<AccountRow> {
    const rows = await tx
      .insert(accounts)
      .values({
        id: input.id,
        emailDigest: input.emailDigest,
        emailCiphertext: input.emailCiphertext,
        emailNonce: input.emailNonce,
        emailKeyId: input.emailKeyId,
        state: 'enabled',
        stateReason: 'registered',
        stateActorType: 'system',
        stateChangedAt: now,
        version: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('insert account returned no row');
    }
    // R1-06C: the append-only audit starts at birth — the initial
    // registered → enabled transition is stamped with the request id.
    await tx.insert(accountStateTransitions).values({
      accountId: row.id,
      fromState: 'registered',
      toState: 'enabled',
      reason: 'registered',
      actorType: 'system',
      actorId: null,
      requestId: input.requestId,
      version: 0,
      createdAt: now,
    });
    return row as unknown as AccountRow;
  }

  async findByEmailDigest(emailDigest: string): Promise<AccountRow | null> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.emailDigest, emailDigest))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as AccountRow);
  }

  async findById(id: string): Promise<AccountRow | null> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as AccountRow);
  }

  async findByIdForUpdate(tx: Db, id: string): Promise<AccountRow | null> {
    const rows = await tx.select().from(accounts).where(eq(accounts.id, id)).for('update').limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as AccountRow);
  }

  async transitionState(input: {
    accountId: string;
    fromState: AccountState;
    toState: AccountState;
    reason: string;
    actorType: StateActorType;
    actorId: string | null;
    requestId: string;
    now: Date;
  }): Promise<AccountRow | null> {
    return await this.db.transaction(async (tx) => {
      const locked = await this.findByIdForUpdate(tx, input.accountId);
      if (locked === null) {
        return null;
      }
      if (locked.state !== input.fromState) {
        throw new Error(
          `state transition ${locked.state} -> ${input.toState} rejected: expected ${input.fromState}`,
        );
      }
      const nextVersion = locked.version + 1;
      const rows = await tx
        .update(accounts)
        .set({
          state: input.toState,
          stateReason: input.reason,
          stateActorType: input.actorType,
          stateActorId: input.actorId,
          stateChangedAt: input.now,
          version: nextVersion,
          updatedAt: input.now,
        })
        .where(eq(accounts.id, input.accountId))
        .returning();
      const updated = rows[0];
      if (updated === undefined) {
        return null;
      }
      await tx.insert(accountStateTransitions).values({
        accountId: input.accountId,
        fromState: locked.state,
        toState: input.toState,
        reason: input.reason,
        actorType: input.actorType,
        actorId: input.actorId,
        requestId: input.requestId,
        version: nextVersion,
        createdAt: input.now,
      });
      return updated as unknown as AccountRow;
    });
  }
}

/** Password credential row — the Argon2id PHC hash lives here, never in logs. */
export interface PasswordCredentialRow {
  accountId: string;
  hash: string;
  hashVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PasswordCredentialRepository {
  upsert(accountId: string, hash: string, now: Date): Promise<void>;
  findByAccountId(accountId: string): Promise<PasswordCredentialRow | null>;
}

export class PgPasswordCredentialRepository implements PasswordCredentialRepository {
  constructor(private readonly db: Db) {}

  async upsert(accountId: string, hash: string, now: Date): Promise<void> {
    await this.db
      .insert(passwordCredentials)
      .values({ accountId, hash, hashVersion: 1, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: passwordCredentials.accountId,
        set: { hash, updatedAt: now },
      });
  }

  async findByAccountId(accountId: string): Promise<PasswordCredentialRow | null> {
    const rows = await this.db
      .select()
      .from(passwordCredentials)
      .where(eq(passwordCredentials.accountId, accountId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      accountId: row.accountId,
      hash: row.hash,
      hashVersion: row.hashVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
