import { Body, Controller, Get, HttpCode, Inject, Post, Put, UseGuards } from '@nestjs/common';
import type {
  AgeDeclarationResponse,
  EligibilityStatusResponse,
  JurisdictionDeclarationResponse,
  ModeEvaluationRequest,
  ModeEvaluationResponse,
} from '@wai/contracts';
import {
  ageDeclarationRequestSchema,
  ageDeclarationResponseSchema,
  jurisdictionDeclarationRequestSchema,
  modeEvaluationRequestSchema,
} from '@wai/contracts';
import { ZodValidationPipe } from '../../infra/pipes/zod-validation.pipe.js';
import { CurrentSession } from '../../account/decorators/current-session.decorator.js';
import { OriginGuard } from '../../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../../account/guards/session-auth.guard.js';
import type { AuthenticatedSession } from '../../account/services/session.service.js';
import { AgeCredentialService } from '../services/age-credential.service.js';
import { JurisdictionService } from '../services/jurisdiction.service.js';
import { ModeEvaluationService } from '../services/mode-evaluation.service.js';

/**
 * ELG-01 public API (task book §6). All routes are session-bound and sit
 * behind SessionAuthGuard — the session cookie is the only credential. The
 * response shapes are derived facts only: a birth date, once declared, is
 * never returned or logged in plaintext. The path omits the v1 prefix —
 * createApiApp applies it globally.
 */
@Controller('eligibility')
@UseGuards(OriginGuard, SessionAuthGuard)
export class EligibilityController {
  constructor(
    @Inject(JurisdictionService) private readonly jurisdiction: JurisdictionService,
    @Inject(AgeCredentialService) private readonly ageCredentials: AgeCredentialService,
    @Inject(ModeEvaluationService) private readonly modeEvaluations: ModeEvaluationService,
  ) {}

  @Put('jurisdiction')
  declareJurisdiction(
    @Body(new ZodValidationPipe(jurisdictionDeclarationRequestSchema))
    body: { country_code: string; subdivision_code?: string },
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<JurisdictionDeclarationResponse> {
    return this.jurisdiction.declare(
      session.accountId,
      body.country_code,
      body.subdivision_code ?? null,
    );
  }

  @Put('age-declaration')
  async declareAge(
    @Body(new ZodValidationPipe(ageDeclarationRequestSchema))
    body: { birth_date: string },
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AgeDeclarationResponse> {
    const view = await this.ageCredentials.declare(session.accountId, body.birth_date);
    // The credential view carries valid_from for status; the declaration
    // response drops it (strict schema — unknown keys are rejected).
    return ageDeclarationResponseSchema.parse({
      credential_id: view.credential_id,
      age_band: view.age_band,
      cohort_key: view.cohort_key,
      assurance_level: view.assurance_level,
      valid_until: view.valid_until,
    });
  }

  @Get('status')
  status(@CurrentSession() session: AuthenticatedSession): Promise<EligibilityStatusResponse> {
    return this.jurisdiction.status(session.accountId);
  }

  // POST by task-book route shape, but the evaluation is a synchronous
  // read-evaluate-append: like the PUT routes it answers 200 with the
  // snapshot, not 201.
  @Post('mode-evaluations')
  @HttpCode(200)
  evaluateMode(
    @Body(new ZodValidationPipe(modeEvaluationRequestSchema))
    body: ModeEvaluationRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ModeEvaluationResponse> {
    return this.modeEvaluations.evaluate(session.accountId, body);
  }
}
