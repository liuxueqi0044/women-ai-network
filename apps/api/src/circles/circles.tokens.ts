import type { InjectionToken } from '@nestjs/common';
import type {
  CircleGrowthGatePort,
  CircleNotificationPort,
  CircleRepositoryPort,
} from '@wai/contracts';
export const CIRCLE_REPOSITORY: InjectionToken<CircleRepositoryPort> = Symbol('CIRCLE_REPOSITORY');
export const CIRCLE_GATE: InjectionToken<CircleGrowthGatePort> = Symbol('CIRCLE_GATE');
export const CIRCLE_NOTIFICATIONS: InjectionToken<CircleNotificationPort> =
  Symbol('CIRCLE_NOTIFICATIONS');
