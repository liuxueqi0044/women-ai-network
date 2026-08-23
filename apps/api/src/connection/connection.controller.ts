import {
  Body,
  Controller,
  Delete,
  Get,
  Query,
  Headers,
  Inject,
  Param,
  Post,
  UseGuards,
  HttpException,
} from '@nestjs/common';
import {
  connectionActionRequestSchema,
  connectionListQuerySchema,
  connectionRequestSchema,
  idSchema,
  connectionListResponseSchema,
  connectionResponseSchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { ConnectionService } from './connection.service.js';

@Controller('connections')
export class ConnectionController {
  constructor(@Inject(ConnectionService) private readonly service: ConnectionService) {}

  @Post('requests')
  @UseGuards(OriginGuard, SessionAuthGuard)
  async request(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const input = connectionRequestSchema.parse(body);
    return connectionResponseSchema.parse(
      await this.service.request(session.accountId, input, requiredKey(key)),
    );
  }

  @Post('requests/:connectionId/accept')
  @UseGuards(OriginGuard, SessionAuthGuard)
  async accept(
    @CurrentSession() session: AuthenticatedSession,
    @Param('connectionId') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.action(session, id, body, 'accept', key);
  }

  @Post('requests/:connectionId/decline')
  @UseGuards(OriginGuard, SessionAuthGuard)
  async decline(
    @CurrentSession() session: AuthenticatedSession,
    @Param('connectionId') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.action(session, id, body, 'decline', key);
  }

  @Post('requests/:connectionId/cancel')
  @UseGuards(OriginGuard, SessionAuthGuard)
  async cancel(
    @CurrentSession() session: AuthenticatedSession,
    @Param('connectionId') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.action(session, id, body, 'cancel', key);
  }

  @Delete(':connectionId')
  @UseGuards(OriginGuard, SessionAuthGuard)
  async disconnect(
    @CurrentSession() session: AuthenticatedSession,
    @Param('connectionId') id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const parsed = parseId(id);
    return connectionResponseSchema.parse(
      await this.service.action(session.accountId, parsed, 'disconnect', requiredKey(key)),
    );
  }

  @Get()
  @UseGuards(SessionAuthGuard)
  async list(@CurrentSession() session: AuthenticatedSession, @Query() query: unknown) {
    return connectionListResponseSchema.parse(
      await this.service.list(session.accountId, parseListQuery(query)),
    );
  }

  @Get(':connectionId')
  @UseGuards(SessionAuthGuard)
  async get(@CurrentSession() session: AuthenticatedSession, @Param('connectionId') id: string) {
    return connectionResponseSchema.parse(await this.service.get(session.accountId, parseId(id)));
  }

  private async action(
    session: AuthenticatedSession,
    id: string,
    body: unknown,
    action: 'accept' | 'decline' | 'cancel',
    key: string | undefined,
  ) {
    connectionActionRequestSchema.parse(body ?? {});
    return connectionResponseSchema.parse(
      await this.service.action(session.accountId, parseId(id), action, requiredKey(key)),
    );
  }
}

function parseId(value: string): string {
  const result = idSchema.safeParse(value);
  if (!result.success)
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'connection id is invalid' }, 400);
  return result.data;
}
function parseListQuery(value: unknown) {
  const result = connectionListQuerySchema.safeParse(value ?? {});
  if (!result.success)
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'List query is invalid' }, 400);
  return result.data;
}
function requiredKey(value: string | undefined): string {
  if (value === undefined || value.length < 16 || value.length > 128)
    throw new HttpException(
      { code: 'VALIDATION_ERROR', message: 'Idempotency-Key is invalid' },
      400,
    );
  return value;
}
