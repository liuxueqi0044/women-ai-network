import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  notificationCategorySchema,
  notificationPreferencesPutSchema,
  notificationReadRequestSchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
@UseGuards(SessionAuthGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly service: NotificationsService) {}
  @Get() list(
    @CurrentSession() session: AuthenticatedSession,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('category') category?: string,
  ) {
    const n = limit ? Number(limit) : 25;
    if (!Number.isInteger(n) || n < 1 || n > 100)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Notification limit is invalid',
      });
    if (category && !notificationCategorySchema.safeParse(category).success)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Notification category is invalid',
      });
    return this.service.list(session.accountId, n, cursor, category);
  }
  @Get('unread-count') unread(@CurrentSession() session: AuthenticatedSession) {
    return this.service.unread(session.accountId);
  }
  @Post('read-all') @UseGuards(OriginGuard) readAll(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(notificationReadRequestSchema)) body: { idempotency_key: string },
  ) {
    return this.service.markAllRead(session.accountId, body.idempotency_key);
  }
  @Post(':id/read') @UseGuards(OriginGuard) read(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(notificationReadRequestSchema)) body: { idempotency_key: string },
  ) {
    return this.service.markRead(session.accountId, id, body.idempotency_key);
  }
  @Get('preferences') preferences(@CurrentSession() session: AuthenticatedSession) {
    return this.service.preferences(session.accountId);
  }
  @Put('preferences') @UseGuards(OriginGuard) replace(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(notificationPreferencesPutSchema)) body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length < 16 || key.length > 128)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Idempotency key is invalid',
      });
    return this.service.replacePreferences(session.accountId, body, key);
  }
}
