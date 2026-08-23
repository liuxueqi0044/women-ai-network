import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import type { IntroductionsService } from './introductions.service.js';
@Controller('introductions')
@UseGuards(SessionAuthGuard)
export class IntroductionsController {
  constructor(@Inject('INTRODUCTIONS_SERVICE') private readonly service: IntroductionsService) {}
  @Get() list(@CurrentSession() s: AuthenticatedSession, @Query() q: unknown) {
    return this.service.list(s.accountId, q);
  }
  @Post(':id/interested') @HttpCode(200) @UseGuards(OriginGuard) interested(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.decide(
      s.accountId,
      id,
      { ...(body as object), decision: 'interested' },
      requiredKey(key),
    );
  }
  @Post(':id/pass') @HttpCode(200) @UseGuards(OriginGuard) pass(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.decide(
      s.accountId,
      id,
      { ...(body as object), decision: 'pass' },
      requiredKey(key),
    );
  }
  @Get('history') history(@CurrentSession() s: AuthenticatedSession, @Query() q: unknown) {
    return this.service.history(s.accountId, q);
  }
  @Get(':id/explanation') explanation(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.explanation(s.accountId, id);
  }
}
function requiredKey(key?: string) {
  if (!key || !/^[\x21-\x7e]{16,128}$/.test(key))
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key is required',
    });
  return key;
}
