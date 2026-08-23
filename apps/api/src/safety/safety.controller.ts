import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  blockCreateRequestSchema,
  reportCreateRequestSchema,
  appealCreateRequestSchema,
  idSchema,
} from '@wai/contracts';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { SafetyService } from './safety.service.js';
@Controller('safety')
@UseGuards(SessionAuthGuard)
export class SafetyController {
  constructor(@Inject(SafetyService) private readonly service: SafetyService) {}
  @Post('blocks') @UseGuards(OriginGuard) async block(
    @CurrentSession() s: AuthenticatedSession,
    @Body(new ZodValidationPipe(blockCreateRequestSchema)) body: unknown,
  ) {
    const r = await this.service.block(
      s.accountId,
      body as { blocked_account_id: string; reason: string; idempotency_key: string },
    );
    return {
      id: r.id,
      blocked_account_id: r.blockedAccountId,
      active: r.state === 'active',
      created_at: r.createdAt.toISOString(),
    };
  }
  @Delete('blocks/:accountId') @HttpCode(204) @UseGuards(OriginGuard) async unblock(
    @CurrentSession() s: AuthenticatedSession,
    @Param('accountId') target: string,
  ) {
    await this.service.revoke(s.accountId, idSchema.parse(target));
  }
  @Get('blocks') async blocks(@CurrentSession() s: AuthenticatedSession) {
    const rows = await this.service.list(s.accountId);
    return {
      blocks: rows.map((r) => ({
        id: r.id,
        blocked_account_id: r.blockedAccountId,
        active: true,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }
  @Post('reports') @UseGuards(OriginGuard) async report(
    @CurrentSession() s: AuthenticatedSession,
    @Body(new ZodValidationPipe(reportCreateRequestSchema)) body: unknown,
  ) {
    const r = await this.service.report(s.accountId, body as never);
    return { id: r.id, state: r.state, created_at: r.createdAt.toISOString() };
  }
  @Get('reports/:id') async getReport(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
  ) {
    const r = await this.service.getReport(s.accountId, idSchema.parse(id));
    return { id: r.id, state: r.state, created_at: r.createdAt.toISOString() };
  }
  @Post('actions/:id/appeals') @UseGuards(OriginGuard) async appeal(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(appealCreateRequestSchema)) body: unknown,
  ) {
    return {
      id: await this.service.appeal(
        s.accountId,
        idSchema.parse(id),
        body as { category: string; statement: string },
      ),
      state: 'submitted',
    };
  }
}
