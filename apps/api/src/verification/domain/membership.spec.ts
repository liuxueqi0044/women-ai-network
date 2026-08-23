import { describe, expect, it } from 'vitest';
import { communityAccess, providerVerifiedDoesNotApproveMembership } from './membership.js';

describe('VER-01 separate conclusions', () => {
  it('provider_verified_does_not_auto_approve_membership', () => {
    expect(providerVerifiedDoesNotApproveMembership('verified', 'under_review')).toBe(
      'under_review',
    );
    expect(providerVerifiedDoesNotApproveMembership('verified', 'not_applied')).toBe('not_applied');
  });
  it('community_access_requires_identity_age_and_membership', () => {
    expect(communityAccess('verified', 'attested', 'approved')).toEqual({
      decision: 'eligible',
      reasons: [],
    });
    const result = communityAccess('verified', 'attested', 'under_review');
    expect(result.decision).toBe('limited');
    expect(result.reasons).toContain('MEMBERSHIP_REVIEW_PENDING');
    expect(communityAccess('verified', 'attested', 'rejected').decision).toBe('denied');
    expect(communityAccess('verified', 'attested', 'approved', false).decision).toBe('denied');
  });
});
