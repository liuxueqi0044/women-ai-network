import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { createOnboardingRepository, parsePiiKeys, type Db } from '@wai/db';
import type { OnboardingModeGate, OnboardingProvider } from '@wai/contracts';
import { IAM_DB } from '../account/repositories.js';
import { ModeEvaluationService } from '../eligibility/services/mode-evaluation.service.js';
import { COMMUNITY_ACCESS_DECISION_PORT } from '../verification/verification.tokens.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import {
  ONBOARDING_MODE_GATE,
  ONBOARDING_PROVIDER,
  ONBOARDING_REPOSITORY,
  ONBOARDING_DISPATCH_LIMITER,
} from './onboarding.tokens.js';
import {
  OnboardingDispatchLimiter,
  SanitizingOnboardingProvider,
  UnavailableOnboardingProvider,
} from './onboarding.provider.js';
import { OnboardingController } from './onboarding.controller.js';
import { OnboardingService } from './onboarding.service.js';
@Module({})
export class OnboardingModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
    verificationModule: DynamicModule,
    provider?: OnboardingProvider,
  ): DynamicModule {
    const gate: Provider = {
      provide: ONBOARDING_MODE_GATE,
      inject: [ModeEvaluationService, COMMUNITY_ACCESS_DECISION_PORT],
      useFactory: (
        evaluation: ModeEvaluationService,
        community: {
          decide(
            accountId: string,
            capability: string,
          ): Promise<{ decision: 'eligible' | 'limited' | 'denied' }>;
        },
      ): OnboardingModeGate => ({
        decide: async (account, mode) => {
          try {
            if ((await community.decide(account, 'onboarding')).decision !== 'eligible')
              return false;
            return (
              (
                await evaluation.evaluate(account, {
                  mode,
                  idempotency_key: `onb-${mode}-${account}`,
                })
              ).decision === 'allow'
            );
          } catch {
            return false;
          }
        },
      }),
    };
    return {
      module: OnboardingModule,
      imports: [accountModule, eligibilityModule, verificationModule],
      controllers: [OnboardingController],
      providers: [
        {
          provide: ONBOARDING_REPOSITORY,
          inject: [IAM_DB],
          useFactory: (db: Db) =>
            createOnboardingRepository(
              db,
              parsePiiKeys(config.iam.piiKeysJson),
              config.iam.piiKeyId,
            ),
        },
        {
          provide: ONBOARDING_PROVIDER,
          useValue: new SanitizingOnboardingProvider(
            provider ?? new UnavailableOnboardingProvider(),
          ),
        },
        { provide: ONBOARDING_DISPATCH_LIMITER, useValue: new OnboardingDispatchLimiter(2) },
        gate,
        OnboardingService,
        OriginGuard,
        SessionAuthGuard,
      ],
      exports: [OnboardingService],
    };
  }
}
