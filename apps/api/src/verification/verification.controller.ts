import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  appealSchema,
  createIdentitySessionSchema,
  identitySessionResponseSchema,
  membershipApplicationSchema,
  verificationStatusSchema,
} from '@wai/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { VerificationService } from './verification.service.js';
import { VerificationWebhookService } from './verification-webhook.service.js';

@Controller('verification')
export class VerificationController {
  constructor(
    @Inject(VerificationService) private readonly service: VerificationService,
    @Inject(VerificationWebhookService) private readonly webhookService: VerificationWebhookService,
  ) {}
  @Post('identity/sessions')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(201)
  async start(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ) {
    const input = createIdentitySessionSchema.parse(body);
    return identitySessionResponseSchema.parse(
      await this.service.createIdentitySession(
        session.accountId,
        requestHeader(request, 'idempotency-key') ?? input.idempotency_key,
      ),
    );
  }
  @Get('status')
  @UseGuards(OriginGuard, SessionAuthGuard)
  async status(@CurrentSession() session: AuthenticatedSession) {
    return verificationStatusSchema.parse(await this.service.status(session.accountId));
  }
  @Post('membership/applications')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(201)
  async application(@CurrentSession() session: AuthenticatedSession, @Body() body: unknown) {
    const input = membershipApplicationSchema.parse(body);
    return verificationStatusSchema.parse(
      await this.service.applyMembership(
        session.accountId,
        input.policy_id,
        input.policy_revision,
        input.statement_category,
      ),
    );
  }
  @Post('membership/appeals')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(201)
  async appeal(@CurrentSession() session: AuthenticatedSession, @Body() body: unknown) {
    const input = appealSchema.parse(body);
    return verificationStatusSchema.parse(
      await this.service.appeal(session.accountId, input.category, input.statement),
    );
  }
  @Post('redaction-requests')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(202)
  async redaction(@CurrentSession() session: AuthenticatedSession) {
    return verificationStatusSchema.parse(await this.service.requestRedaction(session.accountId));
  }
  @Post('providers/:provider/events')
  @HttpCode(200)
  async webhook(
    @Param('provider') providerName: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ) {
    if (!/^[a-z0-9_-]{1,32}$/.test(providerName)) throw new Error('invalid_provider_name');
    const raw = request.rawBody;
    if (raw === undefined) throw new Error('raw_body_unavailable');
    return this.webhookService.handle(
      providerName,
      {
        'x-verification-signature': request.headers['x-verification-signature'] as
          | string
          | undefined,
      },
      raw,
    );
  }
}

function requestHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
