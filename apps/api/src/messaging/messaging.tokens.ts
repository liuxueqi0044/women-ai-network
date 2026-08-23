import type { InjectionToken } from '@nestjs/common';
import type { MessagingRepositoryPort, MessagingWakeupPort } from '@wai/contracts';
export const MESSAGING_REPOSITORY: InjectionToken<MessagingRepositoryPort> = 'MESSAGING_REPOSITORY';
export const MESSAGING_WAKEUP: InjectionToken<MessagingWakeupPort> = 'MESSAGING_WAKEUP';
export const MESSAGING_AI_PROVIDER = 'MESSAGING_AI_PROVIDER';
