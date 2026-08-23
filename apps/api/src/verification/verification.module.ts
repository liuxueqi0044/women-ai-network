import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import {
  COMMUNITY_ACCESS_DECISION_PORT,
  MEMBERSHIP_REVIEW_PORT,
  VERIFICATION_PROVIDER,
} from './verification.tokens.js';
import { MockIdentityVerificationProvider } from './provider/mock-provider.js';
import { UnavailableVerificationProvider } from './provider/unavailable-provider.js';
import { VerificationService } from './verification.service.js';
import { VerificationController } from './verification.controller.js';
import { VerificationWebhookService } from './verification-webhook.service.js';
import { CommunityAccessService } from './community-access.service.js';

@Module({})
export class VerificationModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: VERIFICATION_PROVIDER,
        useFactory: () => {
          const requested = process.env['VERIFICATION_PROVIDER'];
          if (config.isProduction) {
            if (requested === 'mock')
              throw new Error('mock_identity_provider_forbidden_in_production');
            // No real provider has been selected yet: keep the feature unavailable,
            // rather than pretending that a test adapter performed KYC.
            return new UnavailableVerificationProvider();
          }
          return new MockIdentityVerificationProvider({
            secret:
              process.env['VERIFICATION_MOCK_SECRET'] ?? 'test-secret-that-is-at-least-32-bytes',
            ...(process.env['VERIFICATION_MOCK_PREVIOUS_SECRET'] === undefined
              ? {}
              : { previousSecret: process.env['VERIFICATION_MOCK_PREVIOUS_SECRET'] }),
            production: config.isProduction,
          });
        },
      },
      VerificationService,
      VerificationWebhookService,
      CommunityAccessService,
      { provide: MEMBERSHIP_REVIEW_PORT, useExisting: VerificationService },
      { provide: COMMUNITY_ACCESS_DECISION_PORT, useExisting: CommunityAccessService },
      OriginGuard,
      SessionAuthGuard,
    ];
    return {
      module: VerificationModule,
      imports: [accountModule, eligibilityModule],
      controllers: [VerificationController],
      providers,
      exports: [
        VerificationService,
        VerificationWebhookService,
        MEMBERSHIP_REVIEW_PORT,
        COMMUNITY_ACCESS_DECISION_PORT,
      ],
    };
  }
}
