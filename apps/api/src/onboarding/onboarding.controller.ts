import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { idSchema, onboardingPurposeSchema } from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OnboardingService } from './onboarding.service.js';

@Controller('onboarding')
@UseGuards(SessionAuthGuard)
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly service: OnboardingService) {}
  @Post('sessions') @UseGuards(OriginGuard) create(
    @CurrentSession() s: AuthenticatedSession,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.create(s.accountId, b, requiredKey(k));
  }
  @Get('sessions') resume(
    @CurrentSession() s: AuthenticatedSession,
    @Query('purpose') purpose?: string,
  ) {
    return this.service.resume(s.accountId, parsePurpose(purpose));
  }
  @Get('state') state(
    @CurrentSession() s: AuthenticatedSession,
    @Query('purpose') purpose?: string,
  ) {
    return this.service.state(s.accountId, parsePurpose(purpose));
  }
  @Post('sessions/:id/answers') @UseGuards(OriginGuard) answer(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.answer(s.accountId, parseUuid(id), b, requiredKey(k));
  }
  @Post('sessions/:id/extract') @UseGuards(OriginGuard) extract(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.extract(s.accountId, parseUuid(id), b, requiredKey(k));
  }
  @Get('proposals/:purpose/:id') proposal(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Param('purpose') purpose: string,
  ) {
    return this.service.proposal(s.accountId, parsePurpose(purpose), parseUuid(id));
  }
  @Post('confirm') @UseGuards(OriginGuard) confirm(
    @CurrentSession() s: AuthenticatedSession,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.confirm(s.accountId, b, requiredKey(k));
  }
  @Post('correct') @UseGuards(OriginGuard) correct(
    @CurrentSession() s: AuthenticatedSession,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.correct(s.accountId, b, requiredKey(k));
  }
  @Get('preferences') preferences(
    @CurrentSession() s: AuthenticatedSession,
    @Query('purpose') purpose?: string,
  ) {
    return this.service.preferences(s.accountId, parsePurpose(purpose));
  }
  @Put('preferences') @UseGuards(OriginGuard) replace(
    @CurrentSession() s: AuthenticatedSession,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.replacePreferences(s.accountId, b, requiredKey(k));
  }
  @Post('consent') @UseGuards(OriginGuard) consent(
    @CurrentSession() s: AuthenticatedSession,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.consent(s.accountId, b, requiredKey(k));
  }
  @Delete('consent/:purpose/:provider') @UseGuards(OriginGuard) withdraw(
    @CurrentSession() s: AuthenticatedSession,
    @Param('provider') p: string,
    @Param('purpose') purpose: string,
    @Headers('x-consent-receipt-version') v?: string,
    @Headers('idempotency-key') k?: string,
  ) {
    const parsed = Number(v);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new HttpException(
        { code: 'VALIDATION_ERROR', message: 'receipt version is invalid' },
        400,
      );
    return this.service.withdrawConsent(
      s.accountId,
      parsePurpose(purpose),
      parseProvider(p),
      parsed,
      requiredKey(k),
    );
  }
}
function requiredKey(k: string | undefined): string {
  if (!k || k.trim() !== k || !/^[\x21-\x7e]{16,128}$/.test(k))
    throw new HttpException(
      { code: 'VALIDATION_ERROR', message: 'Idempotency-Key is required' },
      400,
    );
  return k;
}
function parseProvider(value: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'provider is invalid' }, 400);
  return value;
}
function parsePurpose(value: string | undefined) {
  const parsed = onboardingPurposeSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'purpose is required' }, 400);
  return parsed.data;
}
function parseUuid(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'id is invalid' }, 400);
  return parsed.data;
}
