import type { InjectionToken } from '@nestjs/common';
import type {
  ConnectionMaterializationPort,
  ConnectionRepositoryPort,
  InteractionGatePort,
  ProfileRelationshipGraphPort,
  PrivateDeliveryConnectionPort,
} from '@wai/contracts';
export const CONNECTION_MATERIALIZATION: InjectionToken<ConnectionMaterializationPort> = Symbol(
  'CONNECTION_MATERIALIZATION',
);

export const CONNECTION_REPOSITORY: InjectionToken<ConnectionRepositoryPort> =
  Symbol('CONNECTION_REPOSITORY');
export const CONNECTION_GATE: InjectionToken<InteractionGatePort> = Symbol('CONNECTION_GATE');
export const CONNECTION_RELATIONSHIP: InjectionToken<ProfileRelationshipGraphPort> =
  Symbol('CONNECTION_RELATIONSHIP');
export const PRIVATE_DELIVERY_CONNECTION: InjectionToken<PrivateDeliveryConnectionPort> = Symbol(
  'PRIVATE_DELIVERY_CONNECTION',
);
