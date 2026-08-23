import { describe, expect, it } from 'vitest';
import { MockIdentityVerificationProvider } from './mock-provider.js';

describe('MockIdentityVerificationProvider', () => {
  it('refuses production and accepts rotated secrets', async () => {
    expect(
      () => new MockIdentityVerificationProvider({ secret: 'a'.repeat(32), production: true }),
    ).toThrow(/production/);
    const provider = new MockIdentityVerificationProvider({
      secret: 'a'.repeat(32),
      previousSecret: 'b'.repeat(32),
    });
    const body = new TextEncoder().encode(
      JSON.stringify({
        provider_event_id: 'evt_2',
        provider_session_reference: 'sess_2',
        event_type: 'session.processing',
        occurred_at: '2026-08-18T00:00:00.000Z',
        decision: 'pending',
        identity_confirmed: false,
        liveness_result: 'not_checked',
        age_thresholds_met: [],
      }),
    );
    await expect(
      provider.verifyWebhook({
        headers: { 'x-verification-signature': provider.sign(body) },
        rawBody: body,
      }),
    ).resolves.toMatchObject({ provider_event_id: 'evt_2' });
    await expect(
      provider.verifyWebhook({
        headers: { 'x-verification-signature': '0'.repeat(64) },
        rawBody: body,
      }),
    ).rejects.toThrow(/signature/);
  });
});
