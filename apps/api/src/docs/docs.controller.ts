import { Controller, Get, Inject, NotFoundException, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '@wai/config';
import { openApiDocument } from '../infra/openapi.js';
import { APP_CONFIG } from '../tokens.js';

/**
 * OpenAPI document endpoint — enabled in non-production by default, in
 * production only via the explicit ENABLE_OPENAPI switch (see packages/config).
 */
@Controller('docs')
export class DocsController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  get(@Res() reply: FastifyReply): void {
    if (!this.config.openapiEnabled) {
      throw new NotFoundException();
    }
    reply.type('application/json').send(openApiDocument);
  }
}
