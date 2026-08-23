import type {
  CommunityAccessResponse,
  CommunityAccessDecision,
  IdentityState,
  AgeAssuranceState,
  MembershipState,
  VerificationReasonCode,
} from '@wai/contracts';

export function providerVerifiedDoesNotApproveMembership(
  identity: IdentityState,
  membership: MembershipState,
): MembershipState {
  // Deliberately return the membership state unchanged. This function is the
  // seam between provider outcomes and the separately authorized review port.
  return identity === 'verified' ? membership : membership;
}

export function communityAccess(
  identity: IdentityState,
  age: AgeAssuranceState,
  membership: MembershipState,
  accountEnabled = true,
): CommunityAccessResponse {
  const reasons: VerificationReasonCode[] = [];
  if (!accountEnabled) reasons.push('ACCOUNT_NOT_ENABLED');
  if (identity !== 'verified')
    reasons.push(
      identity === 'needs_review' ? 'VERIFICATION_NEEDS_REVIEW' : 'IDENTITY_VERIFICATION_REQUIRED',
    );
  if (age !== 'attested')
    reasons.push(age === 'mismatch' ? 'AGE_ASSURANCE_MISMATCH' : 'AGE_ASSURANCE_REQUIRED');
  if (membership === 'not_applied') reasons.push('MEMBERSHIP_APPLICATION_REQUIRED');
  else if (membership === 'submitted' || membership === 'under_review')
    reasons.push('MEMBERSHIP_REVIEW_PENDING');
  else if (membership === 'rejected') reasons.push('MEMBERSHIP_DENIED');
  const decision: CommunityAccessDecision =
    !accountEnabled || membership === 'rejected'
      ? 'denied'
      : reasons.length > 0
        ? 'limited'
        : 'eligible';
  return { decision, reasons };
}
