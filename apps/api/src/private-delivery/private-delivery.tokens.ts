import type { InjectionToken } from '@nestjs/common';
import type { PrivateDeliveryRepositoryPort, PrivateDeliveryWakeupPort } from '@wai/contracts';
export const PRIVATE_DELIVERY_REPOSITORY: InjectionToken<PrivateDeliveryRepositoryPort> = Symbol(
  'PRIVATE_DELIVERY_REPOSITORY',
);
export const PRIVATE_DELIVERY_WAKEUP: InjectionToken<PrivateDeliveryWakeupPort> =
  Symbol('PRIVATE_DELIVERY_WAKEUP');
