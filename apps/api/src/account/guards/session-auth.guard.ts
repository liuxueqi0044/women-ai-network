import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import type { AccountRepository, AuditRepository, Db, SessionRepository } from '@wai/db';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { APP_CONFIG } from '../../tokens.js';
import { sessionCookieName, sessionCookieOptions } from '../http/session-cookie.js';
import { CLOCK, TOKEN_DIGESTER, type Clock, type TokenDigester } from '../ports.js';
import {
  ACCOUNT_REPOSITORY,
  AUDIT_REPOSITORY,
  IAM_DB,
  SESSION_REPOSITORY,
} from '../repositories.js';
import { AccountStateService } from '../services/account-state.service.js';
import { computeIdleExpiryMs } from '../services/session-expiry.js';
import {
  accountStateDenied,
  isSessionExpired,
  replayDetected,
  sessionRequired,
  type AuthenticatedSession,
} from '../services/session.service.js';

/**
 * IAM-01 session guard: resolves the HttpOnly session cookie into an
 * AuthenticatedSession. The token NEVER comes from body/query/bearer — those
 * are simply ignored, so a request without the cookie answers the uniform
 * SESSION_REQUIRED.
 *
 * A ROTATED token resurfacing here (any protected route) is replay: the
 * whole family is compromised in a transaction and the cookie is cleared.
 * Account-state denial revokes the account's sessions and clears the cookie.
 * Expired and revoked sessions are uniformly SESSION_REQUIRED — the client
 * must re-authenticate.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(IAM_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    // Explicit @Inject: vitest's esbuild transform cannot emit
    // design:paramtypes, so class-typed params must declare their token.
    @Inject(AccountStateService) private readonly accountState: AccountStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const token = request.cookies?.[sessionCookieName(this.config)];
    if (typeof token !== 'string' || token.length === 0) {
      throw sessionRequired();
    }

    const nowMs = this.clock.now();
    const row = await this.sessions.findByTokenDigest(this.digester.digest('session', token));
    if (row === null) {
      throw sessionRequired();
    }
    if (row.state === 'rotated') {
      await this.compromiseFamily(row, nowMs, request);
      reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
      throw replayDetected();
    }
    if (row.state !== 'active' || isSessionExpired(row, nowMs)) {
      throw sessionRequired();
    }

    const account = await this.accounts.findById(row.accountId);
    if (account === null || !this.accountState.canAuthenticate(account.state)) {
      const now = new Date(nowMs);
      await this.db.transaction(async (tx) => {
        await this.sessions.revokeByAccount(tx, row.accountId, 'account_state_denied', now);
        await this.audit.appendSecurityEventTx(tx, {
          eventType: 'account.state_denied',
          accountId: row.accountId,
          sessionId: row.id,
          severity: 'warning',
          reason:
            account === null
              ? 'ACCOUNT_STATE_DENIED'
              : `ACCOUNT_STATE_DENIED_${account.state.toUpperCase()}`,
          ipHmac: this.digester.digest('ip', request.ip),
          now,
        });
      });
      reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
      throw accountStateDenied();
    }

    // R1-03: a successful authentication IS activity — slide the idle window
    // (capped at the absolute expiry). The conditional UPDATE only touches a
    // session that is still active and unexpired; a session revoked/rotated
    // concurrently is left alone and simply dies on its next request.
    const idleExpiresAt = new Date(
      computeIdleExpiryMs(
        nowMs,
        this.config.iam.sessionIdleSeconds,
        row.absoluteExpiresAt.getTime(),
      ),
    );
    const touched = await this.sessions.touchActive(
      this.db,
      row.id,
      new Date(nowMs),
      idleExpiresAt,
    );
    if (touched !== 1) {
      // Revocation/rotation/expiry won after the initial read. Never authorize
      // from the stale snapshot when the conditional write proves it is dead.
      // Rotation retains its stronger replay semantics: a concurrent rotate
      // loser must burn the successor family, not degrade to SESSION_REQUIRED.
      const latest = await this.sessions.findById(row.id);
      if (latest?.state === 'rotated') {
        await this.compromiseFamily(latest, nowMs, request);
        reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
        throw replayDetected();
      }
      reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
      throw sessionRequired();
    }

    (request as FastifyRequest & { currentSession?: AuthenticatedSession }).currentSession = {
      sessionId: row.id,
      accountId: row.accountId,
      familyId: row.familyId,
      generation: row.generation,
      authLevel: row.authLevel,
      deviceId: row.deviceId,
    };
    return true;
  }

  /** Replay of a rotated token: burn every active session in the family. */
  private async compromiseFamily(
    row: { familyId: string; accountId: string; id: string },
    nowMs: number,
    request: FastifyRequest,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.sessions.setCompromised(tx, row.familyId, new Date(nowMs));
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'session.replay_detected',
        accountId: row.accountId,
        sessionId: row.id,
        severity: 'critical',
        reason: 'SESSION_REPLAY_DETECTED',
        ipHmac: this.digester.digest('ip', request.ip),
        now: new Date(nowMs),
      });
    });
  }
}
