import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  bcp47LocaleSchema,
  idSchema,
  translationConsentRequestSchema,
  translationConsentResponseSchema,
  translationReadResponseSchema,
  translationRequestBodySchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { TranslationService } from './translation.service.js';

@Controller('letters')
@UseGuards(SessionAuthGuard)
export class TranslationController {
  constructor(@Inject(TranslationService) private readonly service: TranslationService) {}

  @Post(':id/translations')
  @UseGuards(OriginGuard)
  async request(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(translationRequestBodySchema)) body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const parsed = translationRequestBodySchema.parse(body);
    return this.service.request(
      session.accountId,
      { ...parsed, letter_id: idSchema.parse(id) },
      requiredKey(key),
    );
  }

  @Get(':id/translations/:locale')
  async read(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Param('locale') locale: string,
  ) {
    return translationReadResponseSchema.parse(
      await this.service.read(
        session.accountId,
        idSchema.parse(id),
        bcp47LocaleSchema.parse(locale),
      ),
    );
  }

  @Post(':id/translations/consent')
  @UseGuards(OriginGuard)
  async grantConsent(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(translationConsentRequestSchema)) body: unknown,
  ) {
    return translationConsentResponseSchema.parse(
      await this.service.grantConsent(session.accountId, idSchema.parse(id), body),
    );
  }

  @Post(':id/translations/consent/:consentId/revoke')
  @UseGuards(OriginGuard)
  async revokeConsent(
    @CurrentSession() session: AuthenticatedSession,
    @Param('consentId') consentId: string,
  ) {
    return this.service.revokeConsent(session.accountId, idSchema.parse(consentId));
  }
}

function requiredKey(value: string | undefined): string {
  if (value === undefined || value.length < 16 || value.length > 128)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'idempotency key is invalid',
    });
  return value;
}
