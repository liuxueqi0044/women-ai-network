import { describe, expect, it } from 'vitest';
import {
  applyProviderDecision,
  normalizeProviderBody,
  signRawBody,
  verifyRawSignature,
} from './verification-state.js';

const valid = {
  provider_event_id: 'evt_1',
  provider_session_reference: 'sess_1',
  event_type: 'session.verified',
  occurred_at: '2026-08-18T00:00:00.000Z',
  decision: 'verified',
  identity_confirmed: true,
  liveness_result: 'passed',
  age_thresholds_met: [13, 16, 18],
  verified_birth_date: '2000-01-01',
  assurance_expires_at: '2026-12-01T00:00:00.000Z',
};

describe('VER-01 provider boundary', () => {
  it('signed_provider_event_is_idempotent_and_order_safe', () => {
    const body = new TextEncoder().encode(JSON.stringify(valid));
    const signature = signRawBody('a'.repeat(32), body);
    expect(verifyRawSignature(signature, ['a'.repeat(32)], body)).toBe(true);
    expect(
      verifyRawSignature(
        signature,
        ['a'.repeat(32)],
        new TextEncoder().encode(JSON.stringify({ ...valid, decision: 'failed' })),
      ),
    ).toBe(false);
    const event = normalizeProviderBody(body);
    expect(applyProviderDecision('processing', event)).toBe('verified');
    expect(
      applyProviderDecision('verified', {
        ...event,
        decision: 'failed',
        event_type: 'session.failed',
      }),
    ).toBe('verified');
  });
  it('rejects unknown provider fields and malformed signatures', () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ ...valid, secret: 'should-not-cross-boundary' }),
    );
    expect(() => normalizeProviderBody(body)).toThrow();
    expect(verifyRawSignature(undefined, ['a'.repeat(32)], body)).toBe(false);
  });
});
