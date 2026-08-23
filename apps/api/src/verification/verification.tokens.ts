import type { InjectionToken } from '@nestjs/common';
import type {
  CommunityAccessDecisionPort,
  IdentityVerificationProviderPort,
  MembershipReviewPort,
} from '@wai/contracts';
export const VERIFICATION_PROVIDER: InjectionToken<IdentityVerificationProviderPort> =
  Symbol('VERIFICATION_PROVIDER');
export const MEMBERSHIP_REVIEW_PORT: InjectionToken<MembershipReviewPort> =
  Symbol('MEMBERSHIP_REVIEW_PORT');
export const COMMUNITY_ACCESS_DECISION_PORT: InjectionToken<CommunityAccessDecisionPort> = Symbol(
  'COMMUNITY_ACCESS_DECISION_PORT',
);
