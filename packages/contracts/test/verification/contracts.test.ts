import { describe, expect, it } from 'vitest';
import {
  createIdentitySessionSchema,
  membershipApplicationSchema,
  normalizedProviderEventSchema,
  transitionIdentity,
  transitionMembership,
} from '../../src/verification/index.js';

describe('VER-01 contracts', () => {
  it('strictly parses public inputs and provider events', () => {
    expect(createIdentitySessionSchema.safeParse({ idempotency_key: 'a'.repeat(16) }).success).toBe(
      true,
    );
    expect(
      createIdentitySessionSchema.safeParse({
        idempotency_key: 'a'.repeat(16),
        account_id: 'forged',
      }).success,
    ).toBe(false);
    expect(
      membershipApplicationSchema.safeParse({
        policy_id: '00000000-0000-0000-0000-000000000000',
        policy_revision: 1,
        consent: true,
        statement_category: 'community_participation',
      }).success,
    ).toBe(true);
    expect(
      normalizedProviderEventSchema.safeParse({
        provider_event_id: 'e',
        provider_session_reference: 's',
        event_type: 'session.verified',
        occurred_at: '2026-08-18T00:00:00Z',
        decision: 'verified',
        identity_confirmed: true,
        liveness_result: 'passed',
        age_thresholds_met: [],
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      normalizedProviderEventSchema.safeParse({
        provider_event_id: 'e',
        provider_session_reference: 's',
        event_type: 'session.unknown',
        occurred_at: '2026-08-18T00:00:00Z',
        decision: 'unknown',
        identity_confirmed: false,
        liveness_result: 'not_checked',
        age_thresholds_met: [],
      }).success,
    ).toBe(false);
    expect(
      normalizedProviderEventSchema.safeParse({
        provider_event_id: 'e',
        provider_session_reference: 's',
        event_type: 'session.verified',
        occurred_at: '2026-08-18T00:00:00Z',
        decision: 'verified',
        identity_confirmed: false,
        liveness_result: 'failed',
        age_thresholds_met: [18],
      }).success,
    ).toBe(false);
  });
  it('keeps identity and membership state machines independent', () => {
    expect(transitionIdentity('processing', 'verified')).toBe(true);
    expect(transitionIdentity('processing', 'retryable')).toBe(true);
    expect(transitionIdentity('retryable', 'pending')).toBe(true);
    expect(transitionIdentity('verified', 'failed')).toBe(false);
    expect(transitionMembership('under_review', 'approved')).toBe(true);
    expect(transitionMembership('submitted', 'approved')).toBe(true);
  });
});
