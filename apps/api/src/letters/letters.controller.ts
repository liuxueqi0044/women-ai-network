import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  idSchema,
  letterCreateRequestSchema,
  letterOwnerResponseSchema,
  letterListQuerySchema,
  letterListResponseSchema,
  letterPatchRequestSchema,
  letterPublicationSchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { LettersService } from './letters.service.js';

@Controller('letters')
@UseGuards(SessionAuthGuard)
export class LettersController {
  constructor(@Inject(LettersService) private readonly service: LettersService) {}

  @Post()
  @UseGuards(OriginGuard)
  async create(
    @CurrentSession() session: AuthenticatedSession,
    @Body(new ZodValidationPipe(letterCreateRequestSchema)) body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return letterOwnerResponseSchema.parse(
      await this.service.create(session.accountId, body as never, requiredKey(key)),
    );
  }

  @Get()
  async list(
    @CurrentSession() session: AuthenticatedSession,
    @Query(new ZodValidationPipe(letterListQuerySchema)) query: unknown,
  ) {
    return letterListResponseSchema.parse(
      await this.service.list(session.accountId, query as never),
    );
  }

  @Get(':id')
  async read(@CurrentSession() session: AuthenticatedSession, @Param('id') id: string) {
    const result = await this.service.read(session.accountId, idSchema.parse(id));
    return 'kind' in result
      ? letterOwnerResponseSchema.parse(result)
      : letterPublicationSchema.parse(result);
  }

  @Patch(':id')
  @UseGuards(OriginGuard)
  async autosave(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(letterPatchRequestSchema)) body: unknown,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return letterOwnerResponseSchema.parse(
      await this.service.autosave(
        session.accountId,
        idSchema.parse(id),
        body as never,
        version(etag),
        requiredKey(key),
      ),
    );
  }

  @Post(':id/publish')
  @UseGuards(OriginGuard)
  async publish(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return letterOwnerResponseSchema.parse(
      await this.service.publish(
        session.accountId,
        idSchema.parse(id),
        version(etag),
        requiredKey(key),
      ),
    );
  }

  @Post(':id/withdraw')
  @UseGuards(OriginGuard)
  async withdraw(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return letterOwnerResponseSchema.parse(
      await this.service.withdraw(
        session.accountId,
        idSchema.parse(id),
        version(etag),
        requiredKey(key),
      ),
    );
  }

  @Post(':id/archive')
  @UseGuards(OriginGuard)
  async archive(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id') id: string,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return letterOwnerResponseSchema.parse(
      await this.service.archive(
        session.accountId,
        idSchema.parse(id),
        version(etag),
        requiredKey(key),
      ),
    );
  }
}

function requiredKey(value: string | undefined): string {
  if (value === undefined || value.length < 16 || value.length > 128)
    throw new HttpException(
      { code: 'VALIDATION_ERROR', message: 'idempotency key is invalid' },
      400,
    );
  return value;
}

function version(value: string | undefined): number {
  if (value === undefined)
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'if-match is required' }, 400);
  const parsed = Number(value.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'if-match is invalid' }, 400);
  return parsed;
}
