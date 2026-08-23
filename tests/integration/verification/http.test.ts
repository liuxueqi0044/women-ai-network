import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signRawBody } from '../../../apps/api/src/verification/domain/verification-state.js';
import {
  getJson,
  postJson,
  putJson,
  registerAndLogin,
  startEligibilityHarness,
  stopEligibilityHarness,
} from '../eligibility/helpers.js';

const MOCK_SECRET = 'test-secret-that-is-at-least-32-bytes';
let harness: Awaited<ReturnType<typeof startEligibilityHarness>>;
let accountId: string;
let cookie: string;
let previousMockSecret: string | undefined;

beforeAll(async () => {
  previousMockSecret = process.env['VERIFICATION_MOCK_SECRET'];
  process.env['VERIFICATION_MOCK_SECRET'] = MOCK_SECRET;
  harness = await startEligibilityHarness();
  ({ accountId, cookie } = await registerAndLogin(
    harness.baseUrl,
    'verification-http@example.invalid',
  ));
  const jurisdiction = await putJson(
    harness.baseUrl,
    '/v1/eligibility/jurisdiction',
    { country_code: 'US', source: 'self_declared' },
    cookie,
  );
  expect(jurisdiction.status).toBe(200);
});

afterAll(async () => {
  await stopEligibilityHarness({
    api: harness.api,
    started: harness.started,
    pool: harness.pool,
    ...(harness.opa === undefined ? {} : { opa: harness.opa }),
  });
  if (previousMockSecret === undefined) delete process.env['VERIFICATION_MOCK_SECRET'];
  else process.env['VERIFICATION_MOCK_SECRET'] = previousMockSecret;
});

describe('VER-01 authenticated HTTP and raw-body webhook', () => {
  it('enforces session/origin/strict input and idempotent internal session ids', async () => {
    const unauthorized = await getJson(harness.baseUrl, '/v1/verification/status');
    expect(unauthorized.status).toBe(401);

    const badOrigin = await fetch(`${harness.baseUrl}/v1/verification/identity/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://untrusted.example',
      },
      body: JSON.stringify({ idempotency_key: 'verification-http-key-0001' }),
    });
    expect(badOrigin.status).toBe(403);

    const forged = await postJson(
      harness.baseUrl,
      '/v1/verification/identity/sessions',
      {
        idempotency_key: 'verification-http-key-0001',
        account_id: '00000000-0000-4000-8000-000000000000',
      },
      cookie,
    );
    expect(forged.status).toBe(400);

    const created = await postJson(
      harness.baseUrl,
      '/v1/verification/identity/sessions',
      { idempotency_key: 'verification-http-key-0001' },
      cookie,
    );
    expect(created.status).toBe(201);
    const first = (await created.json()) as {
      session_id: string;
      client_token?: string;
      expires_at: string;
    };
    expect(first.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.session_id).not.toContain('mock_session');
    expect(first.client_token).toBeDefined();

    const replay = await postJson(
      harness.baseUrl,
      '/v1/verification/identity/sessions',
      { idempotency_key: 'verification-http-key-0001' },
      cookie,
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({
      session_id: first.session_id,
      expires_at: first.expires_at,
    });

    const raw = Buffer.from(
      JSON.stringify({
        provider_event_id: 'evt-http-verified',
        provider_session_reference: `mock_session_${first.session_id}`,
        event_type: 'session.verified',
        occurred_at: new Date().toISOString(),
        decision: 'verified',
        identity_confirmed: true,
        liveness_result: 'passed',
        verified_birth_date: '1995-05-04',
        age_thresholds_met: [13, 18],
        provider_subject_reference: 'http-provider-subject',
        assurance_expires_at: '2027-08-18T00:00:00Z',
      }),
    );
    const signature = signRawBody(MOCK_SECRET, raw);
    const webhook = await fetch(`${harness.baseUrl}/v1/verification/providers/mock/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-verification-signature': signature,
      },
      body: raw,
    });
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ accepted: true, replay: false });

    const status = await getJson(harness.baseUrl, '/v1/verification/status', cookie);
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({
      identity: 'verified',
      age_assurance: 'attested',
      membership: 'not_applied',
    });
    const serialized = JSON.stringify(statusBody);
    expect(serialized).not.toContain('mock_session');
    expect(serialized).not.toContain('http-provider-subject');
    expect(serialized).not.toContain('1995-05-04');

    const stored = await harness.pool.query<{
      source: string;
      verification_case_id: string;
      assurance_level: string;
    }>(
      `SELECT e.source,e.verification_case_id,c.assurance_level
         FROM eligibility.age_evidence e
         JOIN eligibility.age_credentials c ON c.source_evidence_id=e.id
        WHERE e.account_id=$1 AND e.superseded_at IS NULL`,
      [accountId],
    );
    expect(stored.rows[0]).toMatchObject({
      source: 'verification_provider',
      assurance_level: 'externally_attested',
    });
    expect(stored.rows[0]?.verification_case_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a semantically identical body when its raw bytes do not match the signature', async () => {
    const raw = Buffer.from(
      JSON.stringify({
        provider_event_id: 'evt-http-tampered',
        provider_session_reference: 'not-linked',
        event_type: 'session.processing',
        occurred_at: new Date().toISOString(),
        decision: 'pending',
        identity_confirmed: false,
        liveness_result: 'not_checked',
        age_thresholds_met: [],
      }),
    );
    const response = await fetch(`${harness.baseUrl}/v1/verification/providers/mock/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-verification-signature': signRawBody(MOCK_SECRET, raw),
      },
      body: Buffer.from(`${raw.toString('utf8')} `),
    });
    expect(response.status).toBe(500);
    const count = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM verification.provider_events
        WHERE provider_event_id='evt-http-tampered'`,
    );
    expect(count.rows[0]?.count).toBe('0');
  });
});
