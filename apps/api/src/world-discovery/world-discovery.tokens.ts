import type { InjectionToken } from '@nestjs/common';
import type { WorldDiscoveryRepositoryPort } from '@wai/contracts';
export const WORLD_DISCOVERY_REPOSITORY: InjectionToken<WorldDiscoveryRepositoryPort> = Symbol(
  'WORLD_DISCOVERY_REPOSITORY',
);
