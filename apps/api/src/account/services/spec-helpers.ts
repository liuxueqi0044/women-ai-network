import { expect } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { Db } from '@wai/db';
import type {
  AccountRepository,
  AccountRow,
  AuditRepository,
  DeviceRepository,
  DeviceRow,
  MfaChallengeRow,
  MfaFactorRow,
  MfaRepository,
  NewAccount,
  NewDevice,
  NewMfaChallenge,
  NewMfaFactor,
  NewSession,
  PasswordCredentialRepository,
  PasswordCredentialRow,
  RecoveryCodeRow,
  SecurityEventInput,
  SessionRepository,
  SessionRow,
} from '@wai/db';
import type { AuthProvider, EncryptedSecret, SecretCipher } from '../ports.js';

/**
 * Delegating wrapper that records which AuthProvider methods ran and in what
 * order. The specs use it to prove the timing discipline (dummy verify paid on
 * every anonymous failure, hash-before-lookup on registration) against the
 * deterministic MockAuthProvider.
 */
export class RecordingAuthProvider implements AuthProvider {
  readonly name = 'recording';
  calls: string[] = [];

  constructor(private readonly inner: AuthProvider) {}

  async hashPassword(password: string): Promise<string> {
    this.calls.push('hashPassword');
    return this.inner.hashPassword(password);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    this.calls.push('verifyPassword');
    return this.inner.verifyPassword(hash, password);
  }

  async dummyVerify(password: string): Promise<void> {
    this.calls.push('dummyVerify');
    return this.inner.dummyVerify(password);
  }

  generateTotpSecret(): string {
    return this.inner.generateTotpSecret();
  }

  createTotpUri(secret: string, accountId: string, email: string): string {
    return this.inner.createTotpUri(secret, accountId, email);
  }

  verifyTotp(secret: string, code: string, atSeconds: number): boolean {
    return this.inner.verifyTotp(secret, code, atSeconds);
  }
}

/**
 * In-memory repository fakes for service unit specs. Each one implements the
 * full @wai/db interface so the services run against the real contract, with
 * CP3-relevant behaviour (lookup, insert, events) and honest stubs for the
 * paths later checkpoints will exercise (rotate/revoke/MFA state).
 */

export function makeAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  const now = new Date(1_000_000);
  return {
    id: 'account-1',
    emailDigest: 'digest-1',
    emailCiphertext: 'ct',
    emailNonce: 'nonce',
    emailKeyId: 'dev-key',
    state: 'enabled',
    stateReason: 'registered',
    stateActorType: 'system',
    stateActorId: null,
    stateChangedAt: now,
    version: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

export class FakeAccountRepository implements AccountRepository {
  accounts = new Map<string, AccountRow>();
  byDigest = new Map<string, AccountRow>();
  insertedWithPassword: Array<{ account: NewAccount; hash: string; now: Date }> = [];
  /** R1-06C: transitions written by transitionState + initial registered rows. */
  transitions: Array<{
    accountId: string;
    fromState: string;
    toState: string;
    reason: string;
    actorType: string;
    actorId: string | null;
    requestId: string;
    version: number;
  }> = [];
  /** When set, the next insertWithPassword throws {code: '23505'} (unique violation). */
  uniqueViolationOnNextInsert = false;

  seed(row: AccountRow): void {
    this.accounts.set(row.id, row);
    if (row.emailDigest !== null) {
      this.byDigest.set(row.emailDigest, row);
    }
  }

  async insert(input: NewAccount): Promise<AccountRow> {
    const row = makeAccountRow({ ...input, emailDigest: input.emailDigest });
    this.accounts.set(row.id, row);
    this.byDigest.set(input.emailDigest, row);
    // R1-06C: the append-only audit starts at birth.
    this.transitions.push({
      accountId: row.id,
      fromState: 'registered',
      toState: 'enabled',
      reason: 'registered',
      actorType: 'system',
      actorId: null,
      requestId: input.requestId,
      version: 0,
    });
    return row;
  }

  async insertWithPassword(
    input: NewAccount,
    passwordHash: string,
    now: Date,
  ): Promise<AccountRow> {
    if (this.uniqueViolationOnNextInsert) {
      this.uniqueViolationOnNextInsert = false;
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
    }
    this.insertedWithPassword.push({ account: input, hash: passwordHash, now });
    return this.insert(input);
  }

  async findByEmailDigest(emailDigest: string): Promise<AccountRow | null> {
    return this.byDigest.get(emailDigest) ?? null;
  }

  async findById(id: string): Promise<AccountRow | null> {
    return this.accounts.get(id) ?? null;
  }

  async transitionState(input: {
    accountId: string;
    fromState: AccountRow['state'];
    toState: AccountRow['state'];
    reason: string;
    actorType: AccountRow['stateActorType'];
    actorId: string | null;
    requestId: string;
    now: Date;
  }): Promise<AccountRow | null> {
    const row = this.accounts.get(input.accountId);
    if (row === undefined || row.state !== input.fromState) {
      return null;
    }
    const updated = {
      ...row,
      state: input.toState,
      stateReason: input.reason,
      stateActorType: input.actorType,
      stateActorId: input.actorId,
      stateChangedAt: input.now,
      version: row.version + 1,
      updatedAt: input.now,
    };
    this.accounts.set(updated.id, updated);
    this.transitions.push({
      accountId: input.accountId,
      fromState: input.fromState,
      toState: input.toState,
      reason: input.reason,
      actorType: input.actorType,
      actorId: input.actorId,
      requestId: input.requestId,
      version: updated.version,
    });
    return updated;
  }

  async findByIdForUpdate(_tx: Db, id: string): Promise<AccountRow | null> {
    return this.accounts.get(id) ?? null;
  }
}

export class FakeAuditRepository implements AuditRepository {
  events: SecurityEventInput[] = [];

  async appendSecurityEvent(input: SecurityEventInput): Promise<void> {
    this.events.push(input);
  }

  async appendSecurityEventTx(_tx: Db, input: SecurityEventInput): Promise<void> {
    this.events.push(input);
  }
}

export class FakePasswordCredentialRepository implements PasswordCredentialRepository {
  byAccount = new Map<string, PasswordCredentialRow>();

  async upsert(accountId: string, hash: string, now: Date): Promise<void> {
    this.byAccount.set(accountId, {
      accountId,
      hash,
      hashVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  async findByAccountId(accountId: string): Promise<PasswordCredentialRow | null> {
    return this.byAccount.get(accountId) ?? null;
  }
}

export class FakeSessionRepository implements SessionRepository {
  rows = new Map<string, SessionRow>();
  byTokenDigest = new Map<string, SessionRow>();
  inserted: NewSession[] = [];

  seed(row: SessionRow): void {
    this.rows.set(row.id, row);
    this.byTokenDigest.set(row.tokenDigest, row);
  }

  async insert(input: NewSession): Promise<SessionRow> {
    this.inserted.push(input);
    const row: SessionRow = {
      id: input.id,
      accountId: input.accountId,
      deviceId: input.deviceId,
      familyId: input.familyId,
      parentId: input.parentId,
      successorId: null,
      tokenDigest: input.tokenDigest,
      generation: input.generation,
      state: 'active',
      authLevel: input.authLevel,
      createdAt: input.createdAt,
      lastSeenAt: input.createdAt,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      rotatedAt: null,
      revokedAt: null,
      revokedReason: null,
    };
    this.rows.set(row.id, row);
    this.byTokenDigest.set(row.tokenDigest, row);
    return row;
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRow | null> {
    return this.byTokenDigest.get(tokenDigest) ?? null;
  }

  async findByTokenDigestForUpdate(_tx: Db, tokenDigest: string): Promise<SessionRow | null> {
    return this.byTokenDigest.get(tokenDigest) ?? null;
  }

  async findById(id: string): Promise<SessionRow | null> {
    return this.rows.get(id) ?? null;
  }

  async listActiveByAccount(accountId: string): Promise<SessionRow[]> {
    return this.listActiveByAccountTx(undefined as unknown as Db, accountId);
  }

  async listActiveByAccountTx(_tx: Db, accountId: string): Promise<SessionRow[]> {
    return [...this.rows.values()].filter(
      (row) => row.accountId === accountId && row.state === 'active',
    );
  }

  async findByIdForUpdate(_tx: Db, id: string): Promise<SessionRow | null> {
    return this.rows.get(id) ?? null;
  }

  async rotate(input: { tx: Db; sessionId: string; successor: NewSession; now: Date }): Promise<{
    rotated: SessionRow;
    successor: SessionRow;
  }> {
    const rotated = this.rows.get(input.sessionId);
    if (rotated === undefined) {
      throw new Error('rotate: session to rotate not found');
    }
    const successor = await this.insert(input.successor);
    const updated: SessionRow = {
      ...rotated,
      state: 'rotated',
      rotatedAt: input.now,
      successorId: successor.id,
    };
    this.rows.set(updated.id, updated);
    return { rotated: updated, successor };
  }

  async revokeById(tx: Db, id: string, reason: string, now: Date): Promise<SessionRow | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.state !== 'active') {
      return null;
    }
    const updated: SessionRow = { ...row, state: 'revoked', revokedAt: now, revokedReason: reason };
    this.rows.set(id, updated);
    return updated;
  }

  async revokeMany(tx: Db, ids: string[], reason: string, now: Date): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if ((await this.revokeById(tx, id, reason, now)) !== null) {
        count += 1;
      }
    }
    return count;
  }

  async revokeByAccount(tx: Db, accountId: string, reason: string, now: Date): Promise<number> {
    const ids = [...this.rows.values()]
      .filter((row) => row.accountId === accountId && row.state === 'active')
      .map((row) => row.id);
    return this.revokeMany(tx, ids, reason, now);
  }

  async revokeByDevice(tx: Db, deviceId: string, reason: string, now: Date): Promise<number> {
    const ids = [...this.rows.values()]
      .filter((row) => row.deviceId === deviceId && row.state === 'active')
      .map((row) => row.id);
    return this.revokeMany(tx, ids, reason, now);
  }

  touchCalls: Array<{ id: string; now: Date; idleExpiresAt: Date }> = [];

  async touchActive(_tx: Db, id: string, now: Date, idleExpiresAt: Date): Promise<number> {
    this.touchCalls.push({ id, now, idleExpiresAt });
    const row = this.rows.get(id);
    if (row === undefined || row.state !== 'active') {
      return 0;
    }
    if (
      row.idleExpiresAt.getTime() <= now.getTime() ||
      row.absoluteExpiresAt.getTime() <= now.getTime()
    ) {
      return 0;
    }
    this.rows.set(id, { ...row, lastSeenAt: now, idleExpiresAt });
    return 1;
  }

  async setCompromised(_tx: Db, familyId: string, now: Date): Promise<number> {
    let count = 0;
    for (const [id, row] of this.rows) {
      if (row.familyId === familyId && row.state === 'active') {
        this.rows.set(id, {
          ...row,
          state: 'compromised',
          revokedAt: now,
          revokedReason: 'replay_detected',
        });
        count += 1;
      }
    }
    return count;
  }
}

export function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date(1_000_000);
  return {
    id: 'session-1',
    accountId: 'account-1',
    deviceId: null,
    familyId: 'family-1',
    parentId: null,
    successorId: null,
    tokenDigest: 'digest',
    generation: 1,
    state: 'active',
    authLevel: 'aal1',
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: new Date(1_000_000 + 3_600_000),
    absoluteExpiresAt: new Date(1_000_000 + 86_400_000),
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

export class FakeMfaRepository implements MfaRepository {
  factors = new Map<string, MfaFactorRow>();
  challenges = new Map<string, MfaChallengeRow>();
  byChallengeDigest = new Map<string, MfaChallengeRow>();
  recoveryCodes: RecoveryCodeRow[] = [];
  challengeInserts: NewMfaChallenge[] = [];
  factorInserts: NewMfaFactor[] = [];

  seedFactor(row: MfaFactorRow): void {
    this.factors.set(row.id, row);
  }

  async insertFactor(input: NewMfaFactor): Promise<MfaFactorRow> {
    return this.insertFactorTx(undefined as unknown as Db, input);
  }

  async insertFactorTx(_tx: Db, input: NewMfaFactor): Promise<MfaFactorRow> {
    this.factorInserts.push(input);
    const row: MfaFactorRow = {
      id: input.id,
      accountId: input.accountId,
      type: 'totp',
      state: 'pending',
      secretCiphertext: input.secretCiphertext,
      secretNonce: input.secretNonce,
      secretKeyId: input.secretKeyId,
      createdAt: input.now,
      verifiedAt: null,
      enabledAt: null,
      disabledAt: null,
    };
    this.factors.set(row.id, row);
    return row;
  }

  async findFactorById(accountId: string, factorId: string): Promise<MfaFactorRow | null> {
    const row = this.factors.get(factorId);
    return row !== undefined && row.accountId === accountId ? row : null;
  }

  async listFactorsByAccount(accountId: string): Promise<MfaFactorRow[]> {
    return [...this.factors.values()].filter(
      (row) => row.accountId === accountId && row.state === 'enabled',
    );
  }

  async listActiveFactorsByAccount(accountId: string): Promise<MfaFactorRow[]> {
    return this.listActiveFactorsByAccountTx(undefined as unknown as Db, accountId);
  }

  async listActiveFactorsByAccountTx(_tx: Db, accountId: string): Promise<MfaFactorRow[]> {
    return [...this.factors.values()].filter(
      (row) => row.accountId === accountId && (row.state === 'pending' || row.state === 'enabled'),
    );
  }

  async setFactorEnabled(factorId: string, now: Date): Promise<MfaFactorRow | null> {
    return this.setFactorEnabledTx(undefined as unknown as Db, factorId, now);
  }

  async setFactorDisabled(factorId: string, now: Date): Promise<MfaFactorRow | null> {
    return this.setFactorDisabledTx(undefined as unknown as Db, factorId, now);
  }

  async findPendingByAccount(accountId: string): Promise<MfaFactorRow | null> {
    const rows = [...this.factors.values()].filter(
      (row) => row.accountId === accountId && row.state === 'pending',
    );
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows[0] ?? null;
  }

  async setFactorEnabledTx(_tx: Db, factorId: string, now: Date): Promise<MfaFactorRow | null> {
    const row = this.factors.get(factorId);
    if (row === undefined || row.state !== 'pending') {
      return null;
    }
    const updated: MfaFactorRow = { ...row, state: 'enabled', verifiedAt: now, enabledAt: now };
    this.factors.set(factorId, updated);
    return updated;
  }

  async setFactorDisabledTx(_tx: Db, factorId: string, now: Date): Promise<MfaFactorRow | null> {
    const row = this.factors.get(factorId);
    if (row === undefined) {
      return null;
    }
    const updated: MfaFactorRow = { ...row, state: 'disabled', disabledAt: now };
    this.factors.set(factorId, updated);
    return updated;
  }

  async insertChallenge(input: NewMfaChallenge): Promise<MfaChallengeRow> {
    this.challengeInserts.push(input);
    const row: MfaChallengeRow = {
      id: input.id,
      accountId: input.accountId,
      digest: input.digest,
      state: 'pending',
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      deviceId: input.deviceId,
      methodSet: input.methodSet,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: input.now,
    };
    this.challenges.set(row.id, row);
    this.byChallengeDigest.set(row.digest, row);
    return row;
  }

  async findChallengeByDigest(digest: string): Promise<MfaChallengeRow | null> {
    return this.byChallengeDigest.get(digest) ?? null;
  }

  async consumeChallenge(_tx: Db, challengeId: string, now: Date): Promise<boolean> {
    const row = this.challenges.get(challengeId);
    if (row === undefined || row.state !== 'pending') {
      return false;
    }
    this.setChallenge(challengeId, { ...row, state: 'consumed', consumedAt: now });
    return true;
  }

  async recordChallengeAttempt(
    _tx: Db,
    challengeId: string,
    maxAttempts: number,
  ): Promise<'recorded' | 'exhausted' | 'terminal'> {
    const row = this.challenges.get(challengeId);
    if (row === undefined || row.state !== 'pending' || row.attemptCount >= maxAttempts) {
      return 'terminal';
    }
    const attemptCount = row.attemptCount + 1;
    const exhausted = attemptCount >= maxAttempts;
    this.setChallenge(challengeId, {
      ...row,
      attemptCount,
      state: exhausted ? 'expired' : row.state,
    });
    return exhausted ? 'exhausted' : 'recorded';
  }

  async expirePendingBefore(now: Date): Promise<number> {
    let count = 0;
    for (const [id, row] of this.challenges) {
      if (row.state === 'pending' && row.expiresAt.getTime() < now.getTime()) {
        this.setChallenge(id, { ...row, state: 'expired' });
        count += 1;
      }
    }
    return count;
  }

  /** Keep both the id and digest indexes on the same row object. */
  private setChallenge(id: string, row: MfaChallengeRow): void {
    this.challenges.set(id, row);
    this.byChallengeDigest.set(row.digest, row);
  }

  async insertRecoveryCodes(
    factorId: string,
    accountId: string,
    codes: Array<{ id: string; digest: string }>,
    now: Date,
  ): Promise<void> {
    await this.insertRecoveryCodesTx(undefined as unknown as Db, factorId, accountId, codes, now);
  }

  async insertRecoveryCodesTx(
    _tx: Db,
    factorId: string,
    accountId: string,
    codes: Array<{ id: string; digest: string }>,
    now: Date,
  ): Promise<void> {
    for (const code of codes) {
      this.recoveryCodes.push({
        id: code.id,
        factorId,
        accountId,
        codeDigest: code.digest,
        createdAt: now,
        usedAt: null,
      });
    }
  }

  async consumeRecoveryCode(_tx: Db, codeDigest: string, now: Date): Promise<boolean> {
    const row = this.recoveryCodes.find(
      (code) => code.codeDigest === codeDigest && code.usedAt === null,
    );
    if (row === undefined) {
      return false;
    }
    row.usedAt = now;
    return true;
  }

  async findUnusedRecoveryCode(codeDigest: string): Promise<RecoveryCodeRow | null> {
    return (
      this.recoveryCodes.find((code) => code.codeDigest === codeDigest && code.usedAt === null) ??
      null
    );
  }

  async countUnusedRecoveryCodesByAccount(accountId: string): Promise<number> {
    return this.recoveryCodes.filter((code) => code.accountId === accountId && code.usedAt === null)
      .length;
  }

  async deleteUnusedByFactor(factorId: string): Promise<number> {
    return this.deleteUnusedByFactorTx(undefined as unknown as Db, factorId);
  }

  async deleteUnusedByFactorTx(_tx: Db, factorId: string): Promise<number> {
    const remaining = this.recoveryCodes.filter(
      (code) => !(code.factorId === factorId && code.usedAt === null),
    );
    const deleted = this.recoveryCodes.length - remaining.length;
    this.recoveryCodes = remaining;
    return deleted;
  }
}

/** Assertion helper: the thrown error is the contract HttpException. */
export function expectHttpException(caught: unknown, status: number, code: string): void {
  expect(caught).toBeInstanceOf(HttpException);
  const http = caught as HttpException;
  expect(http.getStatus()).toBe(status);
  const response = http.getResponse() as { code?: unknown; message?: unknown };
  expect(response.code).toBe(code);
  expect(typeof response.message).toBe('string');
}

export function makeDeviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  const now = new Date(1_000_000);
  return {
    id: 'device-1',
    accountId: 'account-1',
    deviceDigest: 'device-digest-1',
    label: 'Chrome on Windows',
    uaDigest: 'ua-digest-1',
    uaSummary: 'Chrome on Windows',
    ipHmac: 'ip-a',
    firstSeenAt: now,
    lastSeenAt: now,
    revokedAt: null,
    ...overrides,
  };
}

export class FakeDeviceRepository implements DeviceRepository {
  rows = new Map<string, DeviceRow>();
  byDigest = new Map<string, DeviceRow>();
  upserted: NewDevice[] = [];

  seed(row: DeviceRow): void {
    this.rows.set(row.id, row);
    this.byDigest.set(`${row.accountId}:${row.deviceDigest}`, row);
  }

  async upsert(input: NewDevice): Promise<DeviceRow> {
    this.upserted.push(input);
    const existing = this.byDigest.get(`${input.accountId}:${input.deviceDigest}`);
    // Mirrors the PG onConflictDoUpdate: same (account, digest) re-activates.
    const row: DeviceRow = {
      id: existing?.id ?? input.id,
      accountId: input.accountId,
      deviceDigest: input.deviceDigest,
      label: input.label,
      uaDigest: input.uaDigest,
      uaSummary: input.uaSummary,
      ipHmac: input.ipHmac,
      firstSeenAt: existing?.firstSeenAt ?? input.now,
      lastSeenAt: input.now,
      revokedAt: null,
    };
    this.rows.set(row.id, row);
    this.byDigest.set(`${row.accountId}:${row.deviceDigest}`, row);
    return row;
  }

  async findByAccountAndDigest(accountId: string, deviceDigest: string): Promise<DeviceRow | null> {
    return this.byDigest.get(`${accountId}:${deviceDigest}`) ?? null;
  }

  async findById(accountId: string, deviceId: string): Promise<DeviceRow | null> {
    const row = this.rows.get(deviceId);
    return row !== undefined && row.accountId === accountId ? row : null;
  }

  async listByAccount(accountId: string): Promise<DeviceRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.accountId === accountId && row.revokedAt === null)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }

  async rename(accountId: string, deviceId: string, label: string): Promise<DeviceRow | null> {
    const row = this.rows.get(deviceId);
    if (row === undefined || row.accountId !== accountId || row.revokedAt !== null) {
      return null;
    }
    const updated = { ...row, label };
    this.rows.set(deviceId, updated);
    return updated;
  }

  async revoke(accountId: string, deviceId: string, now: Date): Promise<DeviceRow | null> {
    return this.revokeTx(undefined as unknown as Db, accountId, deviceId, now);
  }

  async revokeTx(
    _tx: Db,
    accountId: string,
    deviceId: string,
    now: Date,
  ): Promise<DeviceRow | null> {
    const row = this.rows.get(deviceId);
    if (row === undefined || row.accountId !== accountId || row.revokedAt !== null) {
      return null;
    }
    const updated: DeviceRow = { ...row, revokedAt: now };
    this.rows.set(deviceId, updated);
    return updated;
  }
}

/**
 * Deterministic reversible cipher for unit specs — proves WHICH plaintext
 * was encrypted/decrypted and that key_id flows through, without crypto.
 */
export class FakeSecretCipher implements SecretCipher {
  encrypt(keyId: string, plaintext: string): EncryptedSecret {
    return { keyId, nonce: 'nonce', ciphertext: `enc:${plaintext}` };
  }

  decrypt(encrypted: EncryptedSecret): string {
    if (!encrypted.ciphertext.startsWith('enc:')) {
      throw new Error('FakeSecretCipher: unexpected ciphertext');
    }
    return encrypted.ciphertext.slice(4);
  }
}

export function makeMfaFactorRow(overrides: Partial<MfaFactorRow> = {}): MfaFactorRow {
  const now = new Date(1_000_000);
  return {
    id: 'factor-1',
    accountId: 'account-1',
    type: 'totp',
    state: 'pending',
    secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
    secretNonce: 'nonce',
    secretKeyId: 'dev-key',
    createdAt: now,
    verifiedAt: null,
    enabledAt: null,
    disabledAt: null,
    ...overrides,
  };
}

export function makeMfaChallengeRow(overrides: Partial<MfaChallengeRow> = {}): MfaChallengeRow {
  const now = new Date(1_000_000);
  return {
    id: 'challenge-1',
    accountId: 'account-1',
    digest: 'challenge-digest-1',
    state: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    deviceId: 'device-1',
    methodSet: ['totp', 'recovery'],
    expiresAt: new Date(1_000_000 + 300_000),
    consumedAt: null,
    createdAt: now,
    ...overrides,
  };
}

export function makeRecoveryCodeRow(overrides: Partial<RecoveryCodeRow> = {}): RecoveryCodeRow {
  const now = new Date(1_000_000);
  return {
    id: 'recovery-1',
    factorId: 'factor-1',
    accountId: 'account-1',
    codeDigest: 'recovery-digest-1',
    createdAt: now,
    usedAt: null,
    ...overrides,
  };
}
