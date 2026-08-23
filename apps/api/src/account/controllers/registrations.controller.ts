import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { RegistrationRequest, RegistrationResponse } from '@wai/contracts';
import { registrationRequestSchema } from '@wai/contracts';
import { getRequestContext } from '@wai/observability';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../../infra/pipes/zod-validation.pipe.js';
import { OriginGuard } from '../guards/origin.guard.js';
import { TOKEN_DIGESTER, type TokenDigester } from '../ports.js';
import { RegistrationService } from '../services/registration.service.js';

/**
 * POST /v1/account/registrations (task book §7). Accepts email + password
 * only — age/gender/membership fields are rejected by the strict schema.
 */
@Controller('account/registrations')
@UseGuards(OriginGuard)
export class RegistrationsController {
  constructor(
    @Inject(RegistrationService) private readonly registration: RegistrationService,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
  ) {}

  @Post()
  @HttpCode(201)
  register(
    @Body(new ZodValidationPipe(registrationRequestSchema)) body: RegistrationRequest,
    @Req() request: FastifyRequest,
  ): Promise<RegistrationResponse> {
    const store = getRequestContext();
    if (store === undefined) {
      throw new Error('request context missing — registration requires an HTTP request context');
    }
    return this.registration.register({
      email: body.email,
      password: body.password,
      // The full client IP is never stored or logged — only its keyed HMAC.
      ipHmac: this.digester.digest('ip', request.ip),
      // R1-06C: the registration request id lands on the account's initial
      // state transition, so the append-only audit is correlated from birth.
      requestId: store.requestId,
    });
  }
}
