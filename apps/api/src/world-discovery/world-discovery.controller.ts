import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  bookmarkListResponseSchema,
  bookmarkResponseSchema,
  idSchema,
  worldDiscoveryQuerySchema,
  worldDiscoveryResponseSchema,
  worldLetterSchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
import { WorldDiscoveryService } from './world-discovery.service.js';

@Controller('world')
@UseGuards(SessionAuthGuard)
export class WorldDiscoveryController {
  constructor(@Inject(WorldDiscoveryService) private readonly service: WorldDiscoveryService) {}
  @Get('letters') async list(
    @CurrentSession() session: AuthenticatedSession,
    @Query(new ZodValidationPipe(worldDiscoveryQuerySchema)) query: unknown,
  ) {
    const parsed = worldDiscoveryQuerySchema.parse(query);
    return worldDiscoveryResponseSchema.parse(
      await this.service.discover(session.accountId, parsed),
    );
  }
  @Get('letters/:publicationId') async read(
    @CurrentSession() session: AuthenticatedSession,
    @Param('publicationId') id: string,
  ) {
    return worldLetterSchema.parse(await this.service.read(session.accountId, idSchema.parse(id)));
  }
  @Get('letters/:publicationId/bookmark') async status(
    @CurrentSession() session: AuthenticatedSession,
    @Param('publicationId') id: string,
  ) {
    return bookmarkResponseSchema.parse(
      await this.service.bookmarkStatus(session.accountId, idSchema.parse(id)),
    );
  }
  @Put('letters/:publicationId/bookmark') @UseGuards(OriginGuard) async bookmark(
    @CurrentSession() session: AuthenticatedSession,
    @Param('publicationId') id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return bookmarkResponseSchema.parse(
      await this.service.bookmark(session.accountId, idSchema.parse(id), requiredKey(key)),
    );
  }
  @Delete('letters/:publicationId/bookmark') @UseGuards(OriginGuard) async unbookmark(
    @CurrentSession() session: AuthenticatedSession,
    @Param('publicationId') id: string,
  ) {
    return bookmarkResponseSchema.parse(
      await this.service.unbookmark(session.accountId, idSchema.parse(id)),
    );
  }
  @Get('bookmarks') async bookmarks(
    @CurrentSession() session: AuthenticatedSession,
    @Query(new ZodValidationPipe(worldDiscoveryQuerySchema.pick({ cursor: true, limit: true })))
    query: unknown,
  ) {
    const parsed = worldDiscoveryQuerySchema.pick({ cursor: true, limit: true }).parse(query);
    return bookmarkListResponseSchema.parse(
      await this.service.listBookmarks(session.accountId, parsed),
    );
  }
}
function requiredKey(value: string | undefined): string {
  if (value === undefined)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'idempotency key is required',
    });
  if (value.length < 16 || value.length > 128)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'idempotency key is invalid',
    });
  return value;
}
