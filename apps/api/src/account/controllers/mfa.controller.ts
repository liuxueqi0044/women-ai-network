import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type {
  RecoveryRegenerateRequest,
  RecoveryRegenerateResponse,
  TotpDisableRequest,
  TotpEnrollmentConfirmRequest,
  TotpEnrollmentConfirmResponse,
  TotpEnrollmentRequest,
  TotpEnrollmentResponse,
} from '@wai/contracts';
import {
  recoveryRegenerateRequestSchema,
  recoveryRegenerateResponseSchema,
  totpDisableRequestSchema,
  totpEnrollmentConfirmRequestSchema,
  totpEnrollmentConfirmResponseSchema,
  totpEnrollmentRequestSchema,
  totpEnrollmentResponseSchema,
} from '@wai/contracts';
import type { AppConfig } from '@wai/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../../tokens.js';
import { ZodValidationPipe } from '../../infra/pipes/zod-validation.pipe.js';
import { CurrentSession } from '../decorators/current-session.decorator.js';
import { OriginGuard } from '../guards/origin.guard.js';
import { SessionAuthGuard } from '../guards/session-auth.guard.js';
import { sessionCookieName, sessionCookieOptions } from '../http/session-cookie.js';
import { TOKEN_DIGESTER, type TokenDigester } from '../ports.js';
import { MfaService } from '../services/mfa.service.js';
import type { AuthenticatedSession } from '../services/session.service.js';

/**
 * TOTP MFA management (task book §8). Every route requires an authenticated
 * session and re-verifies the password; confirm/disable rotate the CURRENT
 * session to the new auth level (aal2/aal1) and revoke the account's other
 * sessions — the new token is set only after that transaction committed.
 */
@Controller('account/mfa')
@UseGuards(OriginGuard, SessionAuthGuard)
export class MfaController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MfaService) private readonly mfaService: MfaService,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
  ) {}

  /**
   * Enrollment start: password re-verification, then a PENDING factor with an
   * encrypted secret. The otpauth URI (embedding the secret) is returned
   * exactly once — never again, and never stored.
   */
  @Post('totp/enrollment')
  @HttpCode(201)
  async startEnrollment(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(totpEnrollmentRequestSchema)) body: TotpEnrollmentRequest,
    @Req() request: FastifyRequest,
  ): Promise<TotpEnrollmentResponse> {
    const result = await this.mfaService.startEnrollment({
      accountId: session.accountId,
      password: body.password,
      ipHmac: this.digester.digest('ip', request.ip),
    });
    return totpEnrollmentResponseSchema.parse({
      factor_id: result.factorId,
      otpauth_uri: result.otpauthUri,
    });
  }

  /**
   * Confirm: the first correct TOTP code enables the factor, mints the 10
   * one-time recovery codes and rotates the session to AAL2.
   */
  @Post('totp/enrollment/confirm')
  @HttpCode(200)
  async confirmEnrollment(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(totpEnrollmentConfirmRequestSchema))
    body: TotpEnrollmentConfirmRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TotpEnrollmentConfirmResponse> {
    const token = request.cookies?.[sessionCookieName(this.config)];
    try {
      const result = await this.mfaService.confirmEnrollment({
        token: token ?? '',
        accountId: session.accountId,
        totpCode: body.totp_code,
        ipHmac: this.digester.digest('ip', request.ip),
      });
      reply.setCookie(
        sessionCookieName(this.config),
        result.rotated.token,
        sessionCookieOptions(this.config),
      );
      return totpEnrollmentConfirmResponseSchema.parse({ recovery_codes: result.recoveryCodes });
    } catch (error) {
      if (hasEnvelopeCode(error, 'SESSION_REPLAY_DETECTED')) {
        reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
      }
      throw error;
    }
  }

  /** Regenerate: password re-verification, old unused codes die, 10 fresh ones are shown once. */
  @Post('recovery-codes/regenerate')
  @HttpCode(200)
  async regenerateRecoveryCodes(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(recoveryRegenerateRequestSchema)) body: RecoveryRegenerateRequest,
    @Req() request: FastifyRequest,
  ): Promise<RecoveryRegenerateResponse> {
    const codes = await this.mfaService.regenerateRecoveryCodes({
      accountId: session.accountId,
      password: body.password,
      ipHmac: this.digester.digest('ip', request.ip),
    });
    return recoveryRegenerateResponseSchema.parse({ recovery_codes: codes });
  }

  /**
   * Disable: password + a fresh TOTP code or an unused recovery code. The
   * session rotates to AAL1 and the account's other sessions are revoked.
   */
  @Delete('totp')
  @HttpCode(204)
  async disableTotp(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(totpDisableRequestSchema)) body: TotpDisableRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const token = request.cookies?.[sessionCookieName(this.config)];
    try {
      const rotated = await this.mfaService.disableTotp({
        token: token ?? '',
        accountId: session.accountId,
        password: body.password,
        totpCode: body.totp_code,
        recoveryCode: body.recovery_code,
        ipHmac: this.digester.digest('ip', request.ip),
      });
      reply.setCookie(
        sessionCookieName(this.config),
        rotated.token,
        sessionCookieOptions(this.config),
      );
    } catch (error) {
      if (hasEnvelopeCode(error, 'SESSION_REPLAY_DETECTED')) {
        reply.clearCookie(sessionCookieName(this.config), sessionCookieOptions(this.config));
      }
      throw error;
    }
  }
}

function hasEnvelopeCode(error: unknown, code: string): boolean {
  return (
    error instanceof HttpException && (error.getResponse() as { code?: unknown }).code === code
  );
}
