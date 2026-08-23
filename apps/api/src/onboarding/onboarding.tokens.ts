import type { InjectionToken } from '@nestjs/common';
import type {
  OnboardingModeGate,
  OnboardingProvider,
  OnboardingRepositoryPort,
} from '@wai/contracts';
import type { OnboardingDispatchLimiter } from './onboarding.provider.js';
export const ONBOARDING_REPOSITORY: InjectionToken<OnboardingRepositoryPort> =
  Symbol('ONBOARDING_REPOSITORY');
export const ONBOARDING_PROVIDER: InjectionToken<OnboardingProvider> =
  Symbol('ONBOARDING_PROVIDER');
export const ONBOARDING_MODE_GATE: InjectionToken<OnboardingModeGate> =
  Symbol('ONBOARDING_MODE_GATE');
export const ONBOARDING_DISPATCH_LIMITER: InjectionToken<OnboardingDispatchLimiter> = Symbol(
  'ONBOARDING_DISPATCH_LIMITER',
);
