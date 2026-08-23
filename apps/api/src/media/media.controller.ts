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
  mediaAccessRequestSchema,
  mediaAccessResponseSchema,
  mediaCompleteSchema,
  mediaDeleteRequestSchema,
  mediaRedeemRequestSchema,
  mediaDeliveryResponseSchema,
  mediaStatusSchema,
  mediaUploadIntentSchema,
  idSchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { MediaService } from './media.service.js';

@Controller('media')
export class MediaController {
  constructor(@Inject(MediaService) private readonly service: MediaService) {}

  @Post('upload-intents')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(201)
  async intent(@CurrentSession() session: AuthenticatedSession, @Body() body: unknown) {
    const input = mediaUploadIntentSchema.parse(body);
    return this.service.createIntent({
      ownerId: session.accountId,
      purpose: input.purpose,
      declaredSize: input.declared_size,
      idempotencyKey: input.idempotency_key,
      ...(input.declared_content_type === undefined
        ? {}
        : { declaredType: input.declared_content_type }),
    });
  }

  @Post('upload-intents/:assetId/complete')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(202)
  async complete(
    @CurrentSession() session: AuthenticatedSession,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const parsedAssetId = idSchema.parse(assetId);
    const input = mediaCompleteSchema.parse(body);
    return this.service.completeIntent({
      ownerId: session.accountId,
      assetId: parsedAssetId,
      idempotencyKey: input.idempotency_key,
    });
  }

  @Get(':assetId/status')
  @UseGuards(SessionAuthGuard)
  async status(@CurrentSession() session: AuthenticatedSession, @Param('assetId') assetId: string) {
    const parsedAssetId = idSchema.parse(assetId);
    return mediaStatusSchema.parse(await this.service.status(parsedAssetId, session.accountId));
  }

  @Post(':assetId/access')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(200)
  async access(
    @CurrentSession() session: AuthenticatedSession,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const parsedAssetId = idSchema.parse(assetId);
    const input = mediaAccessRequestSchema.parse({ ...(body as object), asset_id: parsedAssetId });
    const capability = await this.service.accessAsset({
      viewerId: session.accountId,
      assetId: input.asset_id,
      purpose: input.purpose,
    });
    return mediaAccessResponseSchema.parse({
      capability: capability.token,
      expires_at: capability.expiresAt.toISOString(),
      content_type: capability.contentType,
      bytes: capability.bytes,
    });
  }

  @Post(':assetId/access/redeem')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(200)
  async redeem(
    @CurrentSession() session: AuthenticatedSession,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const parsedAssetId = idSchema.parse(assetId);
    const input = mediaRedeemRequestSchema.parse(body);
    const delivery = await this.service.redeemAccess({
      viewerId: session.accountId,
      assetId: parsedAssetId,
      token: input.token,
      purpose: input.purpose,
    });
    return mediaDeliveryResponseSchema.parse({
      capability: delivery.token,
      expires_at: delivery.expiresAt.toISOString(),
      content_type: delivery.contentType,
      bytes: delivery.bytes,
      delivery_target: delivery.deliveryTarget,
    });
  }

  @Delete(':assetId')
  @UseGuards(OriginGuard, SessionAuthGuard)
  @HttpCode(204)
  async remove(
    @CurrentSession() session: AuthenticatedSession,
    @Param('assetId') assetId: string,
    @Body() body: unknown,
  ) {
    const parsedAssetId = idSchema.parse(assetId);
    const input = mediaDeleteRequestSchema.parse({ ...(body as object), asset_id: parsedAssetId });
    await this.service.delete(input.asset_id, session.accountId);
  }
}
