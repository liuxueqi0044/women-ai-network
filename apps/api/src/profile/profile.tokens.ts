import type { InjectionToken } from '@nestjs/common';
import type {
  ProfileAgePartitionPort,
  ProfileRelationshipPort,
  ProfileRepositoryPort,
  ProfileVisibilityDecisionPort,
  ProfileMatchingSafeViewPort,
} from '@wai/contracts';
export const PROFILE_REPOSITORY: InjectionToken<ProfileRepositoryPort> =
  Symbol('PROFILE_REPOSITORY');
export const PROFILE_VISIBILITY_POLICY: InjectionToken<ProfileVisibilityDecisionPort> = Symbol(
  'PROFILE_VISIBILITY_POLICY',
);
export const PROFILE_AGE_PARTITION: InjectionToken<ProfileAgePartitionPort> =
  Symbol('PROFILE_AGE_PARTITION');
export const PROFILE_RELATIONSHIP: InjectionToken<ProfileRelationshipPort> =
  Symbol('PROFILE_RELATIONSHIP');
export const PROFILE_MATCHING_SAFE_VIEW: InjectionToken<ProfileMatchingSafeViewPort> = Symbol(
  'PROFILE_MATCHING_SAFE_VIEW',
);
