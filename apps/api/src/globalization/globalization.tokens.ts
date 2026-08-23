import type { InjectionToken } from '@nestjs/common';
import type { GlobalizationRepositoryPort } from '@wai/contracts';
export const GLOBALIZATION_REPOSITORY: InjectionToken<GlobalizationRepositoryPort> = Symbol(
  'GLOBALIZATION_REPOSITORY',
);
