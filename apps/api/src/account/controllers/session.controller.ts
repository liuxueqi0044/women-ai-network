import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { SessionResponse } from '@wai/contracts';
import { sessionResponseSchema } from '@wai/contracts';
import type { AppConfig } from '@wai/config';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { APP_CONFIG } from '../../tokens.js';
import { CurrentSession } from '../decorators/current-session.decorator.js';
import { OriginGuard } from '../guards/origin.guard.js';
import { SessionAuthGuard } from '../guards/session-auth.guard.js';
import { sessionCookieName, sessionCookieOptions } from '../http/session-cookie.js';
import { TOKEN_DIGESTER, type TokenDigester } from '../ports.js';
import {
  SessionService,
  toSessionSummary,
  type AuthenticatedSession,
} from '../services/session.service.js';

/**
 * Current session lifecycle (task book §6): GET the summary, POST rotate for
 * a fresh token (atomic, exactly-one-wins), DELETE to log out. All three sit
 * behind SessionAuthGuard — the token comes ONLY from the HttpOnly cookie.
 */
@Controller('account/session')
@UseGuards(OriginGuard, SessionAuthGuard)
export class SessionController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionService) private readonly sessionService: SessionService,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
  ) {}

  @Get()
  async current(@CurrentSession() session: AuthenticatedSession): Promise<SessionResponse> {
    // The guard already performed the activity touch (R1-03); this only reads.
    const row = await this.sessionService.findOwned(session.accountId, session.sessionId);
    return sessionResponseSchema.parse(
      toSessionSummary({
        sessionId: row.id,
        accountId: row.accountId,
        authLevel: row.authLevel,
        state: row.state,
        createdAtMs: row.createdAt.getTime(),
        lastSeenAtMs: row.lastSeenAt.getTime(),
        idleExpiresAtMs: row.idleExpiresAt.getTime(),
        absoluteExpiresAtMs: row.absoluteExpiresAt.getTime(),
        deviceId: row.deviceId,
      }),
    );
  }

  @Post('rotate')
  @HttpCode(200)
  async rotate(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const token = request.cookies?.[sessionCookieName(this.config)];
    try {
      const rotated = await this.sessionService.rotate({
        token: token ?? '',
        ipHmac: this.digester.digest('ip', request.ip),
      });
      // The new token is set ONLY after the rotate transaction committed.
      reply.setCookie(
        sessionCookieName(this.config),
        rotated.token,
        sessionCookieOptions(this.config),
      );
      return sessionResponseSchema.parse(
        toSessionSummary({
          sessionId: rotated.sessionId,
          accountId: rotated.accountId,
          authLevel: rotated.authLevel,
          state: rotated.state,
          createdAtMs: rotated.createdAtMs,
          lastSeenAtMs: rotated.lastSeenAtMs,
          idleExpiresAtMs: rotated.idleExpiresAtMs,
          absoluteExpiresAtMs: rotated.absoluteExpiresAtMs,
        }),
      );
    } catch (error) {
      // A concurrent rotate won and this request was the replay: clear the
      // stale cookie so the client does not keep resending the dead token.
      if (isReplayDetected(error)) {
        reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
      }
      throw error;
    }
  }

  @Delete()
  @HttpCode(204)
  async logout(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.sessionService.logout({
      accountId: session.accountId,
      sessionId: session.sessionId,
      ipHmac: this.digester.digest('ip', request.ip),
    });
    reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
  }
}

function isReplayDetected(error: unknown): boolean {
  return (
    error instanceof HttpException &&
    (error.getResponse() as { code?: unknown }).code === 'SESSION_REPLAY_DETECTED'
  );
}
