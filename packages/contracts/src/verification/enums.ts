import { z } from 'zod';

export const identityStateSchema = z.enum([
  'not_started',
  'session_created',
  'pending',
  'processing',
  'verified',
  'retryable',
  'requires_input',
  'needs_review',
  'failed',
  'expired',
  'canceled',
]);
export type IdentityState = z.infer<typeof identityStateSchema>;

export const ageAssuranceStateSchema = z.enum([
  'unverified',
  'pending',
  'attested',
  'mismatch',
  'insufficient',
  'needs_review',
  'revoked',
]);
export type AgeAssuranceState = z.infer<typeof ageAssuranceStateSchema>;

export const membershipStateSchema = z.enum([
  'not_applied',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'withdrawn',
]);
export type MembershipState = z.infer<typeof membershipStateSchema>;

export const appealStateSchema = z.enum([
  'none',
  'submitted',
  'under_review',
  'upheld',
  'overturned',
]);
export type AppealState = z.infer<typeof appealStateSchema>;

export const communityAccessDecisionSchema = z.enum(['limited', 'eligible', 'denied']);
export type CommunityAccessDecision = z.infer<typeof communityAccessDecisionSchema>;

export const verificationReasonCodeSchema = z.enum([
  'IDENTITY_VERIFICATION_REQUIRED',
  'AGE_ASSURANCE_REQUIRED',
  'AGE_ASSURANCE_MISMATCH',
  'MEMBERSHIP_APPLICATION_REQUIRED',
  'MEMBERSHIP_REVIEW_PENDING',
  'MEMBERSHIP_DENIED',
  'VERIFICATION_NEEDS_REVIEW',
  'ACCOUNT_NOT_ENABLED',
  'POLICY_NOT_AVAILABLE',
  'SUBJECT_COLLISION',
  'PROVIDER_EVENT_CONFLICT',
]);
export type VerificationReasonCode = z.infer<typeof verificationReasonCodeSchema>;

export const providerEventTypeSchema = z.enum([
  'session.created',
  'session.processing',
  'session.requires_input',
  'session.verified',
  'session.failed',
  'session.expired',
  'session.canceled',
  'session.redacted',
]);
export type ProviderEventType = z.infer<typeof providerEventTypeSchema>;

export const providerDecisionSchema = z.enum([
  'pending',
  'verified',
  'requires_input',
  'failed',
  'expired',
  'canceled',
]);
export type ProviderDecision = z.infer<typeof providerDecisionSchema>;

export const membershipReviewDecisionSchema = z.enum(['approved', 'rejected']);
export type MembershipReviewDecision = z.infer<typeof membershipReviewDecisionSchema>;

export const membershipDecisionReasonCodeSchema = z.enum([
  'POLICY_REQUIREMENTS_MET',
  'INSUFFICIENT_EVIDENCE',
  'POLICY_MISMATCH',
  'SAFETY_REVIEW_REQUIRED',
]);
export type MembershipDecisionReasonCode = z.infer<typeof membershipDecisionReasonCodeSchema>;

export const appealReviewReasonCodeSchema = z.enum([
  'NEW_INFORMATION_ACCEPTED',
  'APPEAL_UPHELD',
  'POLICY_MISMATCH',
  'SAFETY_REVIEW_REQUIRED',
]);
export type AppealReviewReasonCode = z.infer<typeof appealReviewReasonCodeSchema>;

export function transitionIdentity(from: IdentityState, to: IdentityState): boolean {
  if (from === to) return true;
  const allowed: Record<IdentityState, readonly IdentityState[]> = {
    not_started: ['session_created'],
    session_created: ['pending', 'processing', 'retryable', 'expired', 'canceled'],
    pending: [
      'processing',
      'verified',
      'retryable',
      'requires_input',
      'needs_review',
      'failed',
      'expired',
      'canceled',
    ],
    processing: [
      'verified',
      'retryable',
      'requires_input',
      'needs_review',
      'failed',
      'expired',
      'canceled',
    ],
    verified: ['needs_review', 'expired', 'canceled'],
    retryable: ['session_created', 'pending', 'processing', 'failed', 'expired', 'canceled'],
    requires_input: ['session_created', 'pending', 'processing', 'failed', 'expired', 'canceled'],
    needs_review: ['verified', 'failed', 'expired', 'canceled'],
    failed: ['session_created', 'expired', 'canceled'],
    expired: ['session_created'],
    canceled: ['session_created'],
  };
  return allowed[from].includes(to);
}

export function transitionMembership(from: MembershipState, to: MembershipState): boolean {
  if (from === to) return true;
  const allowed: Record<MembershipState, readonly MembershipState[]> = {
    not_applied: ['submitted'],
    submitted: ['under_review', 'approved', 'rejected', 'withdrawn'],
    under_review: ['approved', 'rejected', 'withdrawn'],
    approved: [],
    rejected: ['withdrawn'],
    withdrawn: ['submitted'],
  };
  return allowed[from].includes(to);
}
