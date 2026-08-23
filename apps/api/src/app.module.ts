import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { AppConfig } from '@wai/config';
import { AccountModule } from './account/account.module.js';
import { EligibilityModule } from './eligibility/eligibility.module.js';
import type { OpaConfig } from './eligibility/infra/opa-config.js';
import { GlobalExceptionFilter } from './infra/filters/global-exception.filter.js';
import { InfraModule, type InfraOverrides } from './infra/infra.module.js';
import { RequestContextInterceptor } from './infra/interceptors/request-context.interceptor.js';
import { HealthModule } from './health/health.module.js';
import { FoundationModule } from './foundation/foundation.module.js';
import { DocsController } from './docs/docs.controller.js';
import { VerificationModule } from './verification/verification.module.js';
import { ProfileModule } from './profile/profile.module.js';
import { MediaModule } from './media/media.module.js';
import { SafetyModule } from './safety/safety.module.js';
import { ConnectionModule } from './connection/connection.module.js';
import { LettersModule } from './letters/letters.module.js';
import { PrivateDeliveryModule } from './private-delivery/private-delivery.module.js';
import { TranslationModule } from './translation/translation.module.js';
import { WorldDiscoveryModule } from './world-discovery/world-discovery.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { GlobalizationModule } from './globalization/globalization.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { IntroductionsModule } from './introductions/introductions.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { CirclesModule } from './circles/circles.module.js';

// Kept as a re-export so app.ts can keep its stable import surface; the
// override shape itself lives with the module that consumes it.
export type { InfraOverrides as ApiAppOverrides } from './infra/infra.module.js';

@Module({})
export class AppModule {
  static forRoot(
    config: AppConfig,
    overrides: InfraOverrides = {},
    opaConfig: OpaConfig,
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
      { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    ];

    // One AccountModule reference shared with EligibilityModule — a second
    // forRoot() call would re-register the account controllers.
    const accountModule = AccountModule.forRoot(config);
    const eligibilityModule = EligibilityModule.forRoot(config, accountModule, opaConfig);
    const verificationModule = VerificationModule.forRoot(config, accountModule, eligibilityModule);
    const onboardingModule = OnboardingModule.forRoot(
      config,
      accountModule,
      eligibilityModule,
      verificationModule,
    );
    const safetyModule = SafetyModule.forRoot(config, accountModule);
    const connectionModule = ConnectionModule.forRoot(
      config,
      accountModule,
      eligibilityModule,
      verificationModule,
      safetyModule,
    );
    const lettersModule = LettersModule.forRoot(
      config,
      accountModule,
      eligibilityModule,
      verificationModule,
      safetyModule,
    );
    const privateDeliveryModule = PrivateDeliveryModule.forRoot(
      config,
      accountModule,
      connectionModule,
      lettersModule,
    );
    const worldDiscoveryModule = WorldDiscoveryModule.forRoot(
      config,
      accountModule,
      eligibilityModule,
      verificationModule,
      safetyModule,
    );
    const messagingModule = MessagingModule.forRoot(
      config,
      accountModule,
      connectionModule,
      privateDeliveryModule,
      safetyModule,
    );
    const globalizationModule = GlobalizationModule.forRoot(config, accountModule);
    const profileModule = ProfileModule.forRoot(
      config,
      accountModule,
      eligibilityModule,
      verificationModule,
      connectionModule,
    );
    const introductionsModule = IntroductionsModule.forRoot(
      config,
      accountModule,
      eligibilityModule,
      connectionModule,
      verificationModule,
      safetyModule,
      onboardingModule,
      profileModule,
      undefined,
    );
    const notificationsModule = NotificationsModule.forRoot(
      config,
      accountModule,
      globalizationModule,
    );
    const circlesModule = CirclesModule.forRoot(
      config,
      accountModule,
      eligibilityModule,
      verificationModule,
      safetyModule,
      notificationsModule,
    );

    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(config, overrides),
        HealthModule,
        FoundationModule,
        accountModule,
        eligibilityModule,
        onboardingModule,
        verificationModule,
        safetyModule,
        connectionModule,
        profileModule,
        MediaModule.forRoot(config, accountModule, {
          // Only test adapters may use the fail-closed placeholder;
          // a normal production boot has no overrides and refuses.
          allowUnavailableStorage: overrides.dbAdapter !== undefined,
        }),
        lettersModule,
        privateDeliveryModule,
        TranslationModule.forRoot(config, accountModule, lettersModule),
        worldDiscoveryModule,
        messagingModule,
        globalizationModule,
        introductionsModule,
        notificationsModule,
        circlesModule,
      ],
      controllers: [DocsController],
      providers,
    };
  }
}
