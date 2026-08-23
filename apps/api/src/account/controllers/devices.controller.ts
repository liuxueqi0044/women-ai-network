import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  DeviceIdParams,
  DeviceListResponse,
  DeviceRenameRequest,
  DeviceRenameResponse,
} from '@wai/contracts';
import {
  deviceIdParamsSchema,
  deviceListResponseSchema,
  deviceRenameRequestSchema,
  deviceRenameResponseSchema,
} from '@wai/contracts';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../../infra/pipes/zod-validation.pipe.js';
import { CurrentSession } from '../decorators/current-session.decorator.js';
import { OriginGuard } from '../guards/origin.guard.js';
import { SessionAuthGuard } from '../guards/session-auth.guard.js';
import { TOKEN_DIGESTER, type TokenDigester } from '../ports.js';
import { DeviceService, toDeviceSummary } from '../services/device.service.js';
import type { AuthenticatedSession } from '../services/session.service.js';

/**
 * Device records (task book §9). Devices are created/refreshed at login via
 * the `wai_device` cookie; here the caller can list, rename and revoke them.
 * Revoking a device atomically revokes every active session bound to it.
 * Unknown and cross-account ids answer the same stable 404.
 */
@Controller('account/devices')
@UseGuards(OriginGuard, SessionAuthGuard)
export class DevicesController {
  constructor(
    @Inject(DeviceService) private readonly deviceService: DeviceService,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
  ) {}

  @Get()
  async list(@CurrentSession() session: AuthenticatedSession): Promise<DeviceListResponse> {
    const rows = await this.deviceService.list(session.accountId);
    return deviceListResponseSchema.parse({ devices: rows.map((row) => toDeviceSummary(row)) });
  }

  @Patch(':deviceId')
  @HttpCode(200)
  async rename(
    @CurrentSession() session: AuthenticatedSession,
    @Param('deviceId') deviceId: string,
    @Body(new ZodValidationPipe(deviceRenameRequestSchema)) body: DeviceRenameRequest,
  ): Promise<DeviceRenameResponse> {
    const params: DeviceIdParams = deviceIdParamsSchema.parse({ device_id: deviceId });
    const row = await this.deviceService.rename({
      accountId: session.accountId,
      deviceId: params.device_id,
      label: body.label,
    });
    return deviceRenameResponseSchema.parse(toDeviceSummary(row));
  }

  @Delete(':deviceId')
  @HttpCode(204)
  async revoke(
    @CurrentSession() session: AuthenticatedSession,
    @Param('deviceId') deviceId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const params: DeviceIdParams = deviceIdParamsSchema.parse({ device_id: deviceId });
    await this.deviceService.revoke({
      accountId: session.accountId,
      deviceId: params.device_id,
      ipHmac: this.digester.digest('ip', request.ip),
    });
  }
}
