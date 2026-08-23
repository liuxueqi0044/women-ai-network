import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import type {
  AccountRepository,
  AuditRepository,
  AuthLevel,
  Db,
  NewSession,
  SessionRepository,
  SessionRow,
  SessionState,
} from '@wai/db';
import type { SessionSummary } from '@wai/contracts';
import { APP_CONFIG } from '../../tokens.js';
import {
  ACCOUNT_REPOSITORY,
  AUDIT_REPOSITORY,
  IAM_DB,
  SESSION_REPOSITORY,
} from '../repositories.js';
import {
  CLOCK,
  RANDOM_SOURCE,
  TOKEN_DIGESTER,
  type Clock,
  type RandomSource,
  type TokenDigester,
} from '../ports.js';
import { AccountStateService } from './account-state.service.js';
import { computeIdleExpiryMs } from './session-expiry.js';

/** A session the guard resolved from the cookie — attached to the request. */
export interface AuthenticatedSession {
  sessionId: string;
  accountId: string;
  familyId: string;
  generation: number;
  authLevel: AuthLevel;
  deviceId: string | null;
}

/** Freshly issued session — the token travels ONLY in the HttpOnly cookie. */
export interface IssuedSession {
  sessionId: string;
  accountId: string;
  /** Opaque 256-bit token — travels ONLY in the HttpOnly cookie, never logged. */
  token: string;
  authLevel: AuthLevel;
  state: 'active';
  createdAtMs: number;
  lastSeenAtMs: number;
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
  deviceId: string | null;
}

export interface RotatedSession {
  sessionId: string;
  accountId: string;
  /** Fresh opaque 256-bit token — travels ONLY in the cookie, never logged. */
  token: string;
  authLevel: AuthLevel;
  state: 'active';
  generation: number;
  createdAtMs: number;
  lastSeenAtMs: number;
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
}

/** Stable internal reason codes for security events — never public. */
export const SESSION_REASONS = {
  rotated: 'SESSION_ROTATED',
  /** Rotation triggered by an auth-strength change (MFA enable/disable). */
  rotatedMfaChange: 'SESSION_ROTATED_MFA_CHANGE',
  /** Bulk revocation of the account's other sessions on an MFA strength change. */
  revokedMfaChange: 'mfa_strength_change',
  replayDetected: 'SESSION_REPLAY_DETECTED',
  logout: 'LOGOUT',
  revokedByUser: 'REVOKED_BY_USER',
  accountDenied: 'ACCOUNT_STATE_DENIED',
} as const;

/** Idle OR absolute expiry reached — the session can no longer authenticate. */
export function isSessionExpired(row: SessionRow, nowMs: number): boolean {
  return row.idleExpiresAt.getTime() <= nowMs || row.absoluteExpiresAt.getTime() <= nowMs;
}

/** Public session summary — ids, state and expiries only, never the token. */
export function toSessionSummary(input: {
  sessionId: string;
  accountId: string;
  authLevel: AuthLevel;
  state: SessionState;
  createdAtMs: number;
  lastSeenAtMs: number;
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
  deviceId?: string | null;
}): SessionSummary {
  return {
    session_id: input.sessionId,
    account_id: input.accountId,
    auth_level: input.authLevel,
    state: input.state,
    created_at: new Date(input.createdAtMs).toISOString(),
    last_seen_at: new Date(input.lastSeenAtMs).toISOString(),
    idle_expires_at: new Date(input.idleExpiresAtMs).toISOString(),
    absolute_expires_at: new Date(input.absoluteExpiresAtMs).toISOString(),
    ...(input.deviceId === null || input.deviceId === undefined
      ? {}
      : { device_id: input.deviceId }),
  };
}

/**
 * Session lifecycle (task book §6). The rotate transaction follows the fixed
 * protocol: lock the presented token (SELECT ... FOR UPDATE), and only an
 * active, unexpired session of an enabled account may rotate. A ROTATED token
 * presented again is replay: the whole family is marked compromised and the
 * caller gets SESSION_REPLAY_DETECTED — a retry of an old request kills the
 * successor too, which is the intended security posture.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(IAM_DB) private readonly db: Db,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM_SOURCE) private readonly random: RandomSource,
    // Explicit @Inject: vitest's esbuild transform cannot emit
    // design:paramtypes, so class-typed params must declare their token.
    @Inject(AccountStateService) private readonly accountState: AccountStateService,
  ) {}

  /**
   * Read-only current-session row. The R1-03 guard performs the activity
   * touch at authentication time, so this path only reads — the response
   * reflects the idle window the guard just refreshed.
   */
  async findOwned(accountId: string, sessionId: string): Promise<SessionRow> {
    const row = await this.sessions.findById(sessionId);
    if (row === null || row.accountId !== accountId) {
      throw sessionRequired();
    }
    return row;
  }

  /** Active sessions of the account, newest first — the device list excludes nothing. */
  async list(accountId: string): Promise<SessionRow[]> {
    return this.sessions.listActiveByAccount(accountId);
  }

  /** Fresh session with a new family — login and MFA completion. */
  async issueSession(input: {
    accountId: string;
    authLevel: AuthLevel;
    deviceId: string | null;
    ipHmac: string;
    nowMs: number;
    auditEvent: { eventType: 'login.success' | 'mfa.login_success'; reason: string };
  }): Promise<IssuedSession> {
    const token = this.random.bytes(32).toString('base64url');
    const sessionId = this.random.uuid();
    const now = new Date(input.nowMs);
    const absoluteExpiresAt = new Date(input.nowMs + this.config.iam.sessionAbsoluteSeconds * 1000);
    const row = await this.sessions.insert({
      id: sessionId,
      accountId: input.accountId,
      deviceId: input.deviceId,
      familyId: this.random.uuid(),
      parentId: null,
      tokenDigest: this.digester.digest('session', token),
      generation: 1,
      authLevel: input.authLevel,
      createdAt: now,
      idleExpiresAt: new Date(
        computeIdleExpiryMs(
          input.nowMs,
          this.config.iam.sessionIdleSeconds,
          absoluteExpiresAt.getTime(),
        ),
      ),
      absoluteExpiresAt,
    });
    await this.audit.appendSecurityEvent({
      eventType: input.auditEvent.eventType,
      accountId: input.accountId,
      sessionId,
      severity: 'info',
      reason: input.auditEvent.reason,
      ipHmac: input.ipHmac,
      now,
    });
    return {
      sessionId: row.id,
      accountId: row.accountId,
      token,
      authLevel: row.authLevel,
      state: 'active',
      createdAtMs: row.createdAt.getTime(),
      lastSeenAtMs: row.lastSeenAt.getTime(),
      idleExpiresAtMs: row.idleExpiresAt.getTime(),
      absoluteExpiresAtMs: row.absoluteExpiresAt.getTime(),
      deviceId: row.deviceId,
    };
  }

  /**
   * Atomic rotate (task book §6.2). Exactly one concurrent rotate wins; the
   * loser finds the row `rotated` under the lock and triggers the replay
   * compromise of the whole family.
   *
   * `authLevel` overrides the inherited level (MFA enable → aal2, disable →
   * aal1); `revokeOthers` additionally revokes every OTHER active session of
   * the account in the same transaction (task book §8: strength changes
   * invalidate old sessions). The client-facing 401s (replay/denied) are
   * thrown AFTER the transaction commits so the compromise/revoke + audit
   * events survive — a throw inside the callback would roll them back.
   */
  async rotate(input: {
    token: string;
    ipHmac: string;
    authLevel?: AuthLevel;
    revokeOthers?: boolean;
  }): Promise<RotatedSession> {
    const outcome = await this.db.transaction((tx) => this.rotateInTx(tx, input));
    return outcomeOf(outcome);
  }

  /**
   * The rotate core inside an existing transaction — MFA management services
   * run it in THEIR transaction so the factor change, the recovery-code
   * writes and the session rotation commit atomically.
   */
  async rotateInTx(
    tx: Db,
    input: { token: string; ipHmac: string; authLevel?: AuthLevel; revokeOthers?: boolean },
  ): Promise<RotateOutcome> {
    const digest = this.digester.digest('session', input.token);
    const nowMs = this.clock.now();
    const now = new Date(nowMs);
    const row = await this.sessions.findByTokenDigestForUpdate(tx, digest);
    if (row === null) {
      throw sessionRequired();
    }
    if (row.state === 'rotated') {
      // Replay: the family was rotated by someone else — burn it all.
      await this.sessions.setCompromised(tx, row.familyId, now);
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'session.replay_detected',
        accountId: row.accountId,
        sessionId: row.id,
        severity: 'critical',
        reason: SESSION_REASONS.replayDetected,
        ipHmac: input.ipHmac,
        now,
      });
      return { kind: 'replay' };
    }
    if (row.state !== 'active' || isSessionExpired(row, nowMs)) {
      throw sessionRequired();
    }

    const account = await this.accounts.findByIdForUpdate(tx, row.accountId);
    if (account === null || !this.accountState.canAuthenticate(account.state)) {
      await this.sessions.revokeByAccount(tx, row.accountId, 'account_state_denied', now);
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'account.state_denied',
        accountId: row.accountId,
        sessionId: row.id,
        severity: 'warning',
        reason:
          account === null
            ? SESSION_REASONS.accountDenied
            : `${SESSION_REASONS.accountDenied}_${account.state.toUpperCase()}`,
        ipHmac: input.ipHmac,
        now,
      });
      return { kind: 'denied' };
    }

    const authLevel = input.authLevel ?? row.authLevel;
    const strengthChange = input.authLevel !== undefined && input.authLevel !== row.authLevel;
    if (input.revokeOthers === true) {
      const others = (await this.sessions.listActiveByAccountTx(tx, row.accountId))
        .filter((other) => other.id !== row.id)
        .map((other) => other.id);
      if (others.length > 0) {
        await this.sessions.revokeMany(tx, others, SESSION_REASONS.revokedMfaChange, now);
      }
    }

    const successorToken = this.random.bytes(32).toString('base64url');
    const successor: NewSession = {
      id: this.random.uuid(),
      accountId: row.accountId,
      deviceId: row.deviceId,
      familyId: row.familyId,
      parentId: row.id,
      tokenDigest: this.digester.digest('session', successorToken),
      generation: row.generation + 1,
      authLevel,
      createdAt: now,
      // R1-02: the idle window is capped at the inherited absolute expiry —
      // a rotation near the absolute deadline must never write past it.
      idleExpiresAt: new Date(
        computeIdleExpiryMs(
          nowMs,
          this.config.iam.sessionIdleSeconds,
          row.absoluteExpiresAt.getTime(),
        ),
      ),
      // Absolute expiry is inherited, never extended by rotation.
      absoluteExpiresAt: row.absoluteExpiresAt,
    };
    const { successor: inserted } = await this.sessions.rotate({
      tx,
      sessionId: row.id,
      successor,
      now,
    });
    await this.audit.appendSecurityEventTx(tx, {
      eventType: 'session.rotated',
      accountId: row.accountId,
      sessionId: row.id,
      severity: 'info',
      reason: strengthChange ? SESSION_REASONS.rotatedMfaChange : SESSION_REASONS.rotated,
      ipHmac: input.ipHmac,
      now,
    });
    return {
      kind: 'rotated',
      session: {
        sessionId: inserted.id,
        accountId: inserted.accountId,
        token: successorToken,
        authLevel: inserted.authLevel,
        state: 'active',
        generation: inserted.generation,
        createdAtMs: inserted.createdAt.getTime(),
        lastSeenAtMs: inserted.lastSeenAt.getTime(),
        idleExpiresAtMs: inserted.idleExpiresAt.getTime(),
        absoluteExpiresAtMs: inserted.absoluteExpiresAt.getTime(),
      },
    };
  }

  /** Logout: revoke the caller's own session — no replay semantics. */
  async logout(input: { accountId: string; sessionId: string; ipHmac: string }): Promise<void> {
    const now = new Date(this.clock.now());
    await this.db.transaction(async (tx) => {
      const row = await this.sessions.findByIdForUpdate(tx, input.sessionId);
      if (row === null || row.accountId !== input.accountId || row.state !== 'active') {
        return;
      }
      await this.sessions.revokeById(tx, input.sessionId, 'logout', now);
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'session.revoked',
        accountId: input.accountId,
        sessionId: input.sessionId,
        severity: 'info',
        reason: SESSION_REASONS.logout,
        ipHmac: input.ipHmac,
        now,
      });
    });
  }

  /**
   * Revoke another of the caller's sessions. Cross-account ids answer the
   * same stable 404 as a non-existent id — no resource enumeration.
   */
  async revokeById(input: { accountId: string; sessionId: string; ipHmac: string }): Promise<void> {
    const now = new Date(this.clock.now());
    await this.db.transaction(async (tx) => {
      const row = await this.sessions.findByIdForUpdate(tx, input.sessionId);
      if (row === null || row.accountId !== input.accountId) {
        throw sessionNotFound();
      }
      if (row.state !== 'active') {
        return;
      }
      await this.sessions.revokeById(tx, input.sessionId, 'revoked_by_user', now);
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'session.revoked',
        accountId: input.accountId,
        sessionId: input.sessionId,
        severity: 'info',
        reason: SESSION_REASONS.revokedByUser,
        ipHmac: input.ipHmac,
        now,
      });
    });
  }
}

export type RotateOutcome =
  | { kind: 'rotated'; session: RotatedSession }
  | { kind: 'replay' }
  | { kind: 'denied' };

/** Map a committed rotate outcome to its client-facing exception. */
function outcomeOf(outcome: RotateOutcome): RotatedSession {
  if (outcome.kind === 'rotated') {
    return outcome.session;
  }
  if (outcome.kind === 'replay') {
    throw replayDetected();
  }
  throw accountStateDenied();
}

/** No usable session — the client must authenticate again. */
export function sessionRequired(): HttpException {
  return new HttpException({ code: 'SESSION_REQUIRED', message: 'Session required' }, 401);
}

/** A rotated token resurfaced — the whole family was just compromised. */
export function replayDetected(): HttpException {
  return new HttpException(
    { code: 'SESSION_REPLAY_DETECTED', message: 'Session replay detected' },
    401,
  );
}

/** The account state (suspended/deletion_pending/deleted) blocks the session. */
export function accountStateDenied(): HttpException {
  return new HttpException(
    { code: 'ACCOUNT_STATE_DENIED', message: 'Account state blocks access' },
    401,
  );
}

/** Uniform 404 — non-existent session and someone else's session look identical. */
export function sessionNotFound(): HttpException {
  return new HttpException({ code: 'NOT_FOUND', message: 'Session not found' }, 404);
}
