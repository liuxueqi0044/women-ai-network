import type { InjectionToken } from '@nestjs/common';
import type {
  NotificationRepositoryPort,
  NotificationResourceGatePort,
  NotificationProviderPort,
} from '@wai/contracts';
export const NOTIFICATION_REPOSITORY: InjectionToken<NotificationRepositoryPort> =
  Symbol('NOTIFICATION_REPOSITORY');
export const NOTIFICATION_GATE: InjectionToken<NotificationResourceGatePort> =
  Symbol('NOTIFICATION_GATE');
export const EMAIL_NOTIFICATION_PROVIDER: InjectionToken<NotificationProviderPort | undefined> =
  Symbol('EMAIL_NOTIFICATION_PROVIDER');
export const PUSH_NOTIFICATION_PROVIDER: InjectionToken<NotificationProviderPort | undefined> =
  Symbol('PUSH_NOTIFICATION_PROVIDER');
