import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  aiDraftRequestSchema,
  conversationCreateSchema,
  conversationReadSchema,
  idSchema,
  messageHistoryQuerySchema,
  messageSendSchema,
  messageReportRequestSchema,
  type AiDraftRequest,
  type ConversationCreate,
  type ConversationRead,
  type MessageHistoryQuery,
  type MessageReportRequest,
  type MessageSend,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { MessagingService } from './messaging.service.js';

@Controller('conversations')
@UseGuards(SessionAuthGuard)
export class MessagingController {
  constructor(@Inject(MessagingService) private readonly service: MessagingService) {}
  @Post() @UseGuards(OriginGuard) create(
    @CurrentSession() s: AuthenticatedSession,
    @Body(new ZodValidationPipe(conversationCreateSchema)) b: unknown,
  ) {
    return this.service.create(s.accountId, b as ConversationCreate);
  }
  @Get() list(
    @CurrentSession() s: AuthenticatedSession,
    @Query(new ZodValidationPipe(messageHistoryQuerySchema)) q: unknown,
  ) {
    return this.service.list(s.accountId, q as MessageHistoryQuery);
  }
  @Get('unread-count') unreadCount(@CurrentSession() s: AuthenticatedSession) {
    return this.service.unreadCount(s.accountId);
  }
  @Post(':id/read') @UseGuards(OriginGuard) markConversationRead(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(conversationReadSchema)) body: unknown,
  ) {
    return this.service.markConversationRead(
      s.accountId,
      idSchema.parse(id),
      body as ConversationRead,
    );
  }
  @Get(':id') detail(@CurrentSession() s: AuthenticatedSession, @Param('id') id: string) {
    return this.service.detail(s.accountId, idSchema.parse(id));
  }
  @Get(':id/messages') history(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(messageHistoryQuerySchema)) q: unknown,
  ) {
    return this.service.history(s.accountId, idSchema.parse(id), q as MessageHistoryQuery);
  }
  @Post(':id/messages') @UseGuards(OriginGuard) send(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(messageSendSchema)) b: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length < 16 || key.length > 128)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'idempotency key is invalid',
      });
    return this.service.send(s.accountId, idSchema.parse(id), b as MessageSend, key);
  }
  @Post(':id/subscribe') @UseGuards(OriginGuard) subscribe(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.subscribe(s.accountId, idSchema.parse(id));
  }
  @Post(':id/ai-suggestions') @UseGuards(OriginGuard) draft(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(aiDraftRequestSchema)) b: unknown,
  ) {
    return this.service.draft(s.accountId, idSchema.parse(id), b as AiDraftRequest);
  }
  @Post(':id/report') @UseGuards(OriginGuard) report(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(messageReportRequestSchema)) b: unknown,
  ) {
    return this.service.report(s.accountId, idSchema.parse(id), b as MessageReportRequest);
  }
}
@Controller('messages')
@UseGuards(SessionAuthGuard)
export class MessageController {
  constructor(@Inject(MessagingService) private readonly service: MessagingService) {}
  @Post(':id/withdraw') @UseGuards(OriginGuard) withdraw(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.withdraw(s.accountId, idSchema.parse(id));
  }
  @Post(':id/delivered') @UseGuards(OriginGuard) delivered(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.receipt(s.accountId, idSchema.parse(id), 'delivered');
  }
  @Post(':id/read') @UseGuards(OriginGuard) read(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.receipt(s.accountId, idSchema.parse(id), 'read');
  }
}
@Controller('ai-drafts')
@UseGuards(SessionAuthGuard)
export class AiDraftController {
  constructor(@Inject(MessagingService) private readonly service: MessagingService) {}
  @Get(':id') get(@CurrentSession() s: AuthenticatedSession, @Param('id') id: string) {
    return this.service.getDraft(s.accountId, idSchema.parse(id));
  }
  @Post(':id/delete') @UseGuards(OriginGuard) delete(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.deleteDraft(s.accountId, idSchema.parse(id));
  }
}
