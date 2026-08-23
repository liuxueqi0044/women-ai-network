import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type {
  LoginRequest,
  MfaLoginRequest,
  SessionIdParams,
  SessionListResponse,
  SessionResponse,
} from '@wai/contracts';
import {
  loginRequestSchema,
  mfaLoginRequestSchema,
  sessionIdParamsSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
} from '@wai/contracts';
import type { AppConfig } from '@wai/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../../tokens.js';
import { ZodValidationPipe } from '../../infra/pipes/zod-validation.pipe.js';
import { CurrentSession } from '../decorators/current-session.decorator.js';
import { OriginGuard } from '../guards/origin.guard.js';
import { SessionAuthGuard } from '../guards/session-auth.guard.js';
import {
  DEVICE_COOKIE,
  MFA_CHALLENGE_COOKIE,
  deviceCookieOptions,
  mfaChallengeCookieOptions,
  sessionCookieName,
  sessionCookieOptions,
} from '../http/session-cookie.js';
import { TOKEN_DIGESTER, type TokenDigester } from '../ports.js';
import { LoginService } from '../services/login.service.js';
import { MfaService } from '../services/mfa.service.js';
import {
  SessionService,
  toSessionSummary,
  type AuthenticatedSession,
} from '../services/session.service.js';

/**
 * POST /v1/account/sessions (task book §7).
 *
 * Success (no MFA): 201 + session cookie + session summary. The session token
 * is NEVER in the response body — it travels exclusively in the HttpOnly
 * cookie set here.
 *
 * MFA enabled: no session is issued; only a 5-minute single-use challenge
 * cookie is set and the response is 401 MFA_REQUIRED (completion in CP5).
 */
@Controller('account/sessions')
@UseGuards(OriginGuard)
export class SessionsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LoginService) private readonly loginService: LoginService,
    @Inject(MfaService) private readonly mfaService: MfaService,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
    @Inject(SessionService) private readonly sessionService: SessionService,
  ) {}

  @Post()
  @HttpCode(201)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const outcome = await this.loginService.login({
      email: body.email,
      password: body.password,
      ipHmac: this.digester.digest('ip', request.ip),
      ip: request.ip,
      deviceToken: request.cookies?.[DEVICE_COOKIE] ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (outcome.kind === 'mfa_challenge') {
      reply.setCookie(
        MFA_CHALLENGE_COOKIE,
        outcome.challenge.challengeToken,
        mfaChallengeCookieOptions(this.config),
      );
      // R1-06A: the challenge binds to the device created/refreshed at the
      // password step — the client must keep THIS cookie to complete it.
      reply.setCookie(DEVICE_COOKIE, outcome.deviceToken, deviceCookieOptions(this.config));
      throw new HttpException({ code: 'MFA_REQUIRED', message: 'MFA challenge required' }, 401);
    }

    reply.setCookie(
      sessionCookieName(this.config),
      outcome.session.token,
      sessionCookieOptions(this.config),
    );
    reply.setCookie(DEVICE_COOKIE, outcome.deviceToken, deviceCookieOptions(this.config));
    return sessionResponseSchema.parse(
      toSessionSummary({
        sessionId: outcome.session.sessionId,
        accountId: outcome.session.accountId,
        authLevel: outcome.session.authLevel,
        state: outcome.session.state,
        createdAtMs: outcome.session.createdAtMs,
        lastSeenAtMs: outcome.session.lastSeenAtMs,
        idleExpiresAtMs: outcome.session.idleExpiresAtMs,
        absoluteExpiresAtMs: outcome.session.absoluteExpiresAtMs,
        deviceId: outcome.session.deviceId,
      }),
    );
  }

  /**
   * POST /v1/account/sessions/mfa (task book §8): completes the single-use
   * 5-minute challenge from the password login into an AAL2 session. The
   * challenge cookie is cleared on success and on terminal failures
   * (expired / credentials denied); wrong codes keep it so the client can
   * retry within the attempt budget.
   */
  @Post('mfa')
  @HttpCode(200)
  async mfaLogin(
    @Body(new ZodValidationPipe(mfaLoginRequestSchema)) body: MfaLoginRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const challengeToken = request.cookies?.[MFA_CHALLENGE_COOKIE];
    try {
      const outcome = await this.mfaService.completeMfaLogin({
        challengeToken: challengeToken ?? '',
        totpCode: body.totp_code,
        recoveryCode: body.recovery_code,
        deviceToken: request.cookies?.[DEVICE_COOKIE] ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        ipHmac: this.digester.digest('ip', request.ip),
        ip: request.ip,
      });
      reply.clearCookie(MFA_CHALLENGE_COOKIE, mfaChallengeCookieOptions(this.config));
      reply.setCookie(
        sessionCookieName(this.config),
        outcome.session.token,
        sessionCookieOptions(this.config),
      );
      reply.setCookie(DEVICE_COOKIE, outcome.deviceToken, deviceCookieOptions(this.config));
      return sessionResponseSchema.parse(
        toSessionSummary({
          sessionId: outcome.session.sessionId,
          accountId: outcome.session.accountId,
          authLevel: outcome.session.authLevel,
          state: outcome.session.state,
          createdAtMs: outcome.session.createdAtMs,
          lastSeenAtMs: outcome.session.lastSeenAtMs,
          idleExpiresAtMs: outcome.session.idleExpiresAtMs,
          absoluteExpiresAtMs: outcome.session.absoluteExpiresAtMs,
          deviceId: outcome.session.deviceId,
        }),
      );
    } catch (error) {
      if (
        hasEnvelopeCode(error, 'MFA_CHALLENGE_EXPIRED') ||
        hasEnvelopeCode(error, 'INVALID_CREDENTIALS')
      ) {
        reply.clearCookie(MFA_CHALLENGE_COOKIE, mfaChallengeCookieOptions(this.config));
      }
      throw error;
    }
  }

  /** All active sessions of the caller, newest first. */
  @Get()
  @UseGuards(SessionAuthGuard)
  async list(@CurrentSession() session: AuthenticatedSession): Promise<SessionListResponse> {
    const rows = await this.sessionService.list(session.accountId);
    return sessionListResponseSchema.parse({
      sessions: rows.map((row) =>
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
      ),
    });
  }

  /** Revoke one of the caller's sessions — cross-account ids answer 404. */
  @Delete(':sessionId')
  @HttpCode(204)
  @UseGuards(SessionAuthGuard)
  async revoke(
    @CurrentSession() session: AuthenticatedSession,
    @Param('sessionId') sessionId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const params: SessionIdParams = sessionIdParamsSchema.parse({ session_id: sessionId });
    await this.sessionService.revokeById({
      accountId: session.accountId,
      sessionId: params.session_id,
      ipHmac: this.digester.digest('ip', request.ip),
    });
  }
}

function hasEnvelopeCode(error: unknown, code: string): boolean {
  return (
    error instanceof HttpException && (error.getResponse() as { code?: unknown }).code === code
  );
}
