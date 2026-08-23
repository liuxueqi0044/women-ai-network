import type {
  AgeCredentialIssuer,
  AgeCredentialView,
  AssuranceLevel,
} from '../eligibility/ports.js';
import type {
  CommunityAccessResponse,
  NormalizedProviderEvent,
  VerificationStatus,
} from './schemas.js';
import type { AppealReviewReasonCode, MembershipDecisionReasonCode } from './enums.js';

export interface IdentityVerificationProviderPort {
  /** Stable adapter key used for routing and data partitioning; never user-controlled. */
  readonly name: string;
  createSession(input: {
    caseId: string;
    attemptId: string;
    accountReference: string;
    idempotencyKey: string;
  }): Promise<{ providerSessionReference: string; clientToken: string; expiresAt: string }>;
  verifyWebhook(input: {
    headers: Readonly<Record<string, string | undefined>>;
    rawBody: Uint8Array;
  }): Promise<NormalizedProviderEvent>;
  requestRedaction(providerSessionReference: string): Promise<void>;
}

export interface VerificationRepositoriesPort {
  createCase(
    accountId: string,
    idempotencyKey: string,
  ): Promise<{ caseId: string; attemptId: string }>;
  status(accountId: string): Promise<VerificationStatus>;
}

export interface MembershipReviewPort {
  review(input: {
    caseId: string;
    reviewerPrincipal: string;
    decision: 'approved' | 'rejected';
    reasonCode: MembershipDecisionReasonCode;
  }): Promise<void>;
  reviewAppeal(input: {
    appealId: string;
    reviewerPrincipal: string;
    decision: 'upheld' | 'overturned';
    reasonCode: AppealReviewReasonCode;
  }): Promise<void>;
}

export type VerificationAgeCredentialIssuer = Pick<AgeCredentialIssuer, 'issueExternalAttestation'>;

export interface CommunityAccessDecisionPort {
  decide(accountId: string, capability: string): Promise<CommunityAccessResponse>;
}

export type {
  AgeCredentialView,
  AssuranceLevel,
  NormalizedProviderEvent,
  VerificationStatus,
  CommunityAccessResponse,
};
