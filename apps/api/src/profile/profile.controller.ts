import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  factAudienceSchema,
  factUsageSchema,
  factWriteSchema,
  profileMutationResponseSchema,
  profilePreviewQuerySchema,
  profilePublishResponseSchema,
  profileWriteSchema,
} from '@wai/contracts';
import { z } from 'zod';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { ProfileService } from './profile.service.js';

@Controller('profile')
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly service: ProfileService) {}

  @Get('me') @UseGuards(SessionAuthGuard) me(@CurrentSession() session: AuthenticatedSession) {
    return this.service.selfView(session.accountId);
  }

  @Put('me') @UseGuards(OriginGuard, SessionAuthGuard) async update(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: unknown,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const input = profileWriteSchema.parse(body);
    return profileMutationResponseSchema.parse(
      await this.service.update(
        session.accountId,
        {
          displayName: input.display_name,
          ...(input.city === undefined ? {} : { city: input.city }),
          ...(input.country_code === undefined ? {} : { countryCode: input.country_code }),
        },
        version(etag),
        requiredKey(key),
      ),
    );
  }
  @Put('me/facts/:factKey') @UseGuards(OriginGuard, SessionAuthGuard) async putFact(
    @CurrentSession() session: AuthenticatedSession,
    @Param('factKey') factKey: string,
    @Body() body: unknown,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const input = factWriteSchema.parse(body);
    return profileMutationResponseSchema.parse(
      await this.service.putFact(
        session.accountId,
        factKey,
        input,
        version(etag),
        requiredKey(key),
      ),
    );
  }
  @Delete('me/facts/:factKey') @UseGuards(OriginGuard, SessionAuthGuard) async withdraw(
    @CurrentSession() session: AuthenticatedSession,
    @Param('factKey') factKey: string,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return profileMutationResponseSchema.parse(
      await this.service.withdrawFact(session.accountId, factKey, version(etag), requiredKey(key)),
    );
  }
  @Put('me/facts/:factKey/usage') @UseGuards(OriginGuard, SessionAuthGuard) async usage(
    @CurrentSession() session: AuthenticatedSession,
    @Param('factKey') factKey: string,
    @Body() body: unknown,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return profileMutationResponseSchema.parse(
      await this.service.setUsage(
        session.accountId,
        factKey,
        factUsageSchema.parse(body),
        version(etag),
        requiredKey(key),
      ),
    );
  }
  @Put('me/facts/:factKey/audience') @UseGuards(OriginGuard, SessionAuthGuard) async audience(
    @CurrentSession() session: AuthenticatedSession,
    @Param('factKey') factKey: string,
    @Body() body: unknown,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return profileMutationResponseSchema.parse(
      await this.service.setAudience(
        session.accountId,
        factKey,
        factAudienceSchema.parse(body),
        version(etag),
        requiredKey(key),
      ),
    );
  }
  @Post('me/publish') @UseGuards(OriginGuard, SessionAuthGuard) async publish(
    @CurrentSession() session: AuthenticatedSession,
    @Headers('if-match') etag: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return profilePublishResponseSchema.parse(
      await this.service.publish(session.accountId, version(etag), requiredKey(key)),
    );
  }
  @Get('me/preview') @UseGuards(SessionAuthGuard) preview(
    @CurrentSession() session: AuthenticatedSession,
    @Query() query: unknown,
  ) {
    const input = profilePreviewQuerySchema.parse(query);
    return this.service.preview(session.accountId, input.view, input.mode);
  }
}

@Controller('profiles')
export class PublicProfileController {
  constructor(@Inject(ProfileService) private readonly service: ProfileService) {}
  @Get(':profileId') @UseGuards(SessionAuthGuard) view(
    @CurrentSession() session: AuthenticatedSession,
    @Param('profileId') profileId: string,
    @Query() query: unknown,
  ) {
    const parsedProfileId = z.string().uuid().safeParse(profileId);
    if (!parsedProfileId.success)
      throw new HttpException({ code: 'VALIDATION_ERROR', message: 'profile id is invalid' }, 400);
    const input = profilePreviewQuerySchema.parse({
      view: 'member',
      ...(query as Record<string, unknown>),
    });
    return this.service.viewerView(session.accountId, parsedProfileId.data, input.mode);
  }
}

function version(value: string | undefined): number {
  if (value === undefined)
    throw new HttpException(
      { code: 'PRECONDITION_REQUIRED', message: 'If-Match is required' },
      428,
    );
  const parsed = Number(value.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new HttpException(
      { code: 'VALIDATION_ERROR', message: 'If-Match must be a profile version' },
      400,
    );
  return parsed;
}
function requiredKey(value: string | undefined): string {
  if (value === undefined || value.length < 16 || value.length > 128)
    throw new HttpException(
      { code: 'VALIDATION_ERROR', message: 'Idempotency-Key is invalid' },
      400,
    );
  return value;
}
