import type { InjectionToken } from '@nestjs/common';
import type { WorldDiscoveryGateService } from './world-discovery-gate.service.js';

export const WORLD_DISCOVERY_GATE: InjectionToken<WorldDiscoveryGateService> =
  Symbol('WORLD_DISCOVERY_GATE');
