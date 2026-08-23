import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ERROR_CODES,
  globalizationCatalogSchema,
  globalizationPreferencesRequestSchema,
  globalizationPreferencesSchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { GlobalizationService } from './globalization.service.js';

@Controller('globalization')
export class GlobalizationController {
  constructor(@Inject(GlobalizationService) private readonly service: GlobalizationService) {}
  @Get('catalog') catalog() {
    return globalizationCatalogSchema.parse(this.service.catalog());
  }
  @Get('preferences') @UseGuards(SessionAuthGuard) async read(
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return globalizationPreferencesSchema.parse(await this.service.read(session.accountId));
  }
  @Put('preferences') @UseGuards(SessionAuthGuard, OriginGuard) async replace(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(globalizationPreferencesRequestSchema)) body: unknown,
    @Headers('if-match') versionHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const expected = parseVersion(versionHeader);
    if (idempotencyKey === undefined || idempotencyKey.length < 16 || idempotencyKey.length > 128)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'idempotency key is invalid',
      });
    return globalizationPreferencesSchema.parse(
      await this.service.replace(session.accountId, body, expected, idempotencyKey),
    );
  }
}
function parseVersion(header: string | undefined): number {
  if (header === undefined || header.trim() === '')
    throw new HttpException(
      { code: ERROR_CODES.PRECONDITION_REQUIRED, message: 'If-Match is required' },
      428,
    );
  const match = /^W\/\"?(\d+)\"?$/.exec(header.trim()) ?? /^\"?(\d+)\"?$/.exec(header.trim());
  if (match === null)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'If-Match version is invalid',
    });
  return Number(match[1]);
}
