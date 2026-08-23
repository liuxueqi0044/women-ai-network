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
  idSchema,
  privateDeliveryCreateRequestSchema,
  privateDeliveryEvidenceRequestSchema,
  privateDeliveryListQuerySchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { PrivateDeliveryService } from './private-delivery.service.js';

@Controller('private-letter-deliveries')
@UseGuards(SessionAuthGuard)
export class PrivateDeliveryController {
  constructor(@Inject(PrivateDeliveryService) private readonly service: PrivateDeliveryService) {}
  @Post()
  @UseGuards(OriginGuard)
  create(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(privateDeliveryCreateRequestSchema)) body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length < 16 || key.length > 128)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'idempotency key is invalid',
      });
    return this.service.create(session.accountId, body as never, key);
  }
  @Get('inbox') inbox(
    @CurrentSession() session: AuthenticatedSession,
    @Query(new ZodValidationPipe(privateDeliveryListQuerySchema)) query: unknown,
  ) {
    return this.service.inbox(session.accountId, query as never);
  }
  @Get('sent') sent(
    @CurrentSession() session: AuthenticatedSession,
    @Query(new ZodValidationPipe(privateDeliveryListQuerySchema)) query: unknown,
  ) {
    return this.service.sent(session.accountId, query as never);
  }
  @Get('inbox/:id') read(@CurrentSession() session: AuthenticatedSession, @Param('id') id: string) {
    return this.service.read(session.accountId, idSchema.parse(id));
  }
  @Get('sent/:id') sentRead(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.sentRead(session.accountId, idSchema.parse(id));
  }
  @Post('inbox/:id/read') @UseGuards(OriginGuard) markRead(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.markRead(session.accountId, idSchema.parse(id));
  }
  @Post('inbox/:id/hide') @UseGuards(OriginGuard) hide(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    return this.service.hide(session.accountId, idSchema.parse(id));
  }
  @Post('sent/:id/withdraw')
  @UseGuards(OriginGuard)
  withdraw(@CurrentSession() session: AuthenticatedSession, @Param('id') id: string) {
    return this.service.withdraw(session.accountId, idSchema.parse(id));
  }
  @Post('inbox/:id/evidence')
  @UseGuards(OriginGuard)
  evidence(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(privateDeliveryEvidenceRequestSchema)) body: unknown,
  ) {
    return this.service.captureEvidence(
      session.accountId,
      idSchema.parse(id),
      (body as { category: string }).category,
    );
  }
  @Post('sent/:id/evidence')
  @UseGuards(OriginGuard)
  sentEvidence(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(privateDeliveryEvidenceRequestSchema)) body: unknown,
  ) {
    return this.service.captureEvidence(
      session.accountId,
      idSchema.parse(id),
      (body as { category: string }).category,
    );
  }
}
