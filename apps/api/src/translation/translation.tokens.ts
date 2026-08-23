import type { InjectionToken } from '@nestjs/common';
import type {
  TranslationProvider,
  TranslationRepositoryPort,
  TranslationSourcePort,
} from '@wai/contracts';

export const TRANSLATION_REPOSITORY: InjectionToken<TranslationRepositoryPort> =
  Symbol('TRANSLATION_REPOSITORY');
export const TRANSLATION_SOURCE: InjectionToken<TranslationSourcePort> =
  Symbol('TRANSLATION_SOURCE');
export const TRANSLATION_PROVIDERS: InjectionToken<ReadonlyMap<string, TranslationProvider>> =
  Symbol('TRANSLATION_PROVIDERS');
