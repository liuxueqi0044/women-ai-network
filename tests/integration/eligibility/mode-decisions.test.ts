import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AppConfig } from '@wai/config';
import { OPEN_ENDED } from '@wai/contracts';
import type { StartedInfra, StartedOpa } from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import {
  postJson,
  putJson,
  registerAndLogin,
  startEligibilityHarness,
  stopEligibilityHarness,
  type ApiApp,
} from './helpers.js';
import {
  SYNTHETIC_CA_POLICY_ID,
  SYNTHETIC_POLICY_ID,
  insertApprovedPolicy,
  seedCaPolicy,
  syntheticPolicyDocument,
} from './seed.js';

/**
 * CP5 evidence over real Postgres + Valkey + the REAL OPA container: the
 * mode evaluation vertical (task book §6). The six-mode matrix against the
 * committed Rego (fixed reason-code order), subdivision override vs country
 * fallback, the immutable decision snapshot keyed by the deterministic
 * decision_id (replay returns the stored row; a new policy revision never
 * rewrites an old decision), half-open effective-time boundaries, and the
 * fail-closed path when the policy engine is unreachable.
 */

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALL_MODES = ['friends', 'activities', 'professional', 'circles', 'events', 'dating'];

interface ModeResponse {
  decision_id: string;
  decision: string;
  mode: string;
  age_band: string;
  cohort_key: string;
  reason_codes: string[];
  obligations: string[];
  policy: { policy_id: string; revision: number; policy_hash: string };
  credential: { credential_id: string; assurance_level: string };
  evaluated_at: string;
  valid_until: string;
}

type EvaluationBody = ModeResponse | { code: string; message: string };

let emailSeq = 0;

function freshEmail(): string {
  emailSeq += 1;
  return `mode-decisions-${emailSeq}@example.invalid`;
}

/** A credential cannot be used before it was issued; evaluate just after issuance. */
function anHourAgo(): string {
  return new Date().toISOString();
}

describe('mode evaluation over the real policy engine', () => {
  let started: StartedInfra;
  let pool: Pool;
  let config: AppConfig;
  let baseUrl: string;
  let api: ApiApp;
  let opa: StartedOpa | undefined;

  beforeAll(async () => {
    const harness = await startEligibilityHarness({ opa: true });
    started = harness.started;
    pool = harness.pool;
    config = harness.config;
    baseUrl = harness.baseUrl;
    api = harness.api;
    opa = harness.opa;
    await seedCaPolicy(harness.db);
  }, 180_000);

  afterAll(async () => {
    await stopEligibilityHarness({ api, started, pool, ...(opa === undefined ? {} : { opa }) });
  });

  async function setupModeAccount(
    birthDate: string,
    jurisdiction: { countryCode: string; subdivisionCode?: string } = { countryCode: 'US' },
  ): Promise<string> {
    const account = await registerAndLogin(baseUrl, freshEmail());
    const declared = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      {
        country_code: jurisdiction.countryCode,
        ...(jurisdiction.subdivisionCode === undefined
          ? {}
          : { subdivision_code: jurisdiction.subdivisionCode }),
      },
      account.cookie,
    );
    expect(declared.status).toBe(200);
    const aged = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: birthDate },
      account.cookie,
    );
    expect(aged.status).toBe(200);
    return account.cookie;
  }

  async function evaluate(
    cookie: string,
    body: { mode: string; effective_at?: string; idempotency_key?: string },
  ): Promise<{ status: number; body: EvaluationBody }> {
    const response = await postJson(baseUrl, '/v1/eligibility/mode-evaluations', body, cookie);
    return { status: response.status, body: (await response.json()) as EvaluationBody };
  }

  it('allows an adult on all six modes with a deterministic v5 decision_id', async () => {
    const cookie = await setupModeAccount('2000-06-15');
    const effectiveAt = anHourAgo();
    for (const mode of ALL_MODES) {
      const { status, body } = await evaluate(cookie, { mode, effective_at: effectiveAt });
      expect(status, mode).toBe(200);
      const evaluated = body as ModeResponse;
      expect(evaluated).toMatchObject({
        scope: 'age_and_jurisdiction',
        decision: 'allow',
        mode,
        age_band: 'adult',
        cohort_key: 'adult',
        assurance_level: 'self_declared',
        reason_codes: [],
        obligations: [],
        policy: { policy_id: SYNTHETIC_POLICY_ID, revision: 1 },
        credential: { assurance_level: 'self_declared' },
        evaluated_at: effectiveAt,
      });
      expect(evaluated.valid_until).not.toBe(OPEN_ENDED);
      expect(evaluated.decision_id).toMatch(UUID_V5);
      expect(evaluated.policy.policy_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(evaluated.credential.credential_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('a 17-year-old is allowed on friends but denied dating (ADULT_THRESHOLD_NOT_MET)', async () => {
    const cookie = await setupModeAccount('2009-06-15');
    const friends = await evaluate(cookie, { mode: 'friends' });
    expect(friends.status).toBe(200);
    expect((friends.body as ModeResponse).decision).toBe('allow');

    const dating = await evaluate(cookie, { mode: 'dating' });
    expect(dating.status).toBe(200);
    expect((dating.body as ModeResponse).decision).toBe('deny');
    expect((dating.body as ModeResponse).reason_codes).toEqual(['ADULT_THRESHOLD_NOT_MET']);
    expect((dating.body as ModeResponse).obligations).toEqual([]);
  });

  it('a 14-year-old is denied with PARENTAL_CONSENT_REQUIRED and the obligation', async () => {
    const cookie = await setupModeAccount('2012-06-15');
    const { status, body } = await evaluate(cookie, { mode: 'friends' });
    expect(status).toBe(200);
    expect(body as ModeResponse).toMatchObject({
      decision: 'deny',
      reason_codes: ['PARENTAL_CONSENT_REQUIRED'],
      obligations: ['parental_consent_required'],
    });
  });

  it('a 12-year-old is denied with the fixed ordered reason codes', async () => {
    const cookie = await setupModeAccount('2014-06-15');
    const { status, body } = await evaluate(cookie, { mode: 'friends' });
    expect(status).toBe(200);
    expect(body as ModeResponse).toMatchObject({
      decision: 'deny',
      reason_codes: [
        'BELOW_MINIMUM_ACCOUNT_AGE',
        'PARENTAL_CONSENT_REQUIRED',
        'MODE_MINIMUM_AGE_NOT_MET',
      ],
      obligations: ['parental_consent_required'],
    });
  });

  it('subdivision policy overrides the country fallback; a country-only declaration falls back', async () => {
    // 16-year-old: under the CA policy (parental consent below 18) denied,
    // under the US fallback (below 16) allowed — the same person, different
    // policy documents, proves which one the selector picked.
    const ca = await setupModeAccount('2010-06-15', { countryCode: 'US', subdivisionCode: 'CA' });
    const caResult = await evaluate(ca, { mode: 'friends' });
    expect(caResult.status).toBe(200);
    expect(caResult.body as ModeResponse).toMatchObject({
      decision: 'deny',
      reason_codes: ['PARENTAL_CONSENT_REQUIRED'],
      policy: { policy_id: SYNTHETIC_CA_POLICY_ID, revision: 1 },
    });

    const us = await setupModeAccount('2010-06-15', { countryCode: 'US' });
    const usResult = await evaluate(us, { mode: 'friends' });
    expect(usResult.status).toBe(200);
    expect(usResult.body as ModeResponse).toMatchObject({
      decision: 'allow',
      reason_codes: [],
      policy: { policy_id: SYNTHETIC_POLICY_ID, revision: 1 },
    });
  });

  it('replays an identical request from the stored snapshot; a different key is a different decision', async () => {
    const cookie = await setupModeAccount('2000-06-15');
    const request = {
      mode: 'circles',
      effective_at: anHourAgo(),
      idempotency_key: 'k-integration-1',
    };
    const first = await evaluate(cookie, request);
    expect(first.status).toBe(200);
    const second = await evaluate(cookie, request);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eligibility.mode_decisions WHERE decision_id = $1`,
      [(first.body as ModeResponse).decision_id],
    );
    expect(count.rows[0]?.n).toBe('1');
    expect((second.body as ModeResponse).decision_id).toBe(
      (first.body as ModeResponse).decision_id,
    );

    const other = await evaluate(cookie, { ...request, idempotency_key: 'k-integration-2' });
    expect(other.status).toBe(200);
    expect((other.body as ModeResponse).decision_id).not.toBe(
      (first.body as ModeResponse).decision_id,
    );
  });

  it('persists a defaulted effective_at per account, key, and mode', async () => {
    const cookie = await setupModeAccount('2000-06-15');
    const first = await evaluate(cookie, {
      mode: 'friends',
      idempotency_key: 'k-defaulted-integration',
    });
    expect(first.status).toBe(200);
    const replay = await evaluate(cookie, {
      mode: 'friends',
      idempotency_key: 'k-defaulted-integration',
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const otherMode = await evaluate(cookie, {
      mode: 'events',
      idempotency_key: 'k-defaulted-integration',
    });
    expect(otherMode.status).toBe(200);
    expect((otherMode.body as ModeResponse).mode).toBe('events');
    expect((otherMode.body as ModeResponse).decision_id).not.toBe(
      (first.body as ModeResponse).decision_id,
    );
  });

  it('fails closed with a deny snapshot and an evaluation_failure event when OPA is unreachable', async () => {
    // A second app on the same infra whose policy engine is a dead port:
    // the full HTTP surface (session, DTO, service, adapter) against an
    // unreachable engine must answer 200 deny, not 5xx.
    const deadApp = await createApiApp(
      config,
      {},
      { baseUrl: 'http://127.0.0.1:9', queryTimeoutMs: 300 },
    );
    await deadApp.listen(0, '127.0.0.1');
    const server = deadApp.getHttpServer();
    const address = server.address();
    const port = address === null || typeof address === 'string' ? 0 : address.port;
    const deadBaseUrl = `http://127.0.0.1:${port}`;
    try {
      const account = await registerAndLogin(deadBaseUrl, freshEmail());
      await putJson(
        deadBaseUrl,
        '/v1/eligibility/jurisdiction',
        { country_code: 'US' },
        account.cookie,
      );
      const aged = await putJson(
        deadBaseUrl,
        '/v1/eligibility/age-declaration',
        { birth_date: '2000-06-15' },
        account.cookie,
      );
      expect(aged.status).toBe(200);

      const response = await postJson(
        deadBaseUrl,
        '/v1/eligibility/mode-evaluations',
        { mode: 'friends', idempotency_key: 'k-engine-down' },
        account.cookie,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as ModeResponse;
      expect(body).toMatchObject({
        decision: 'deny',
        reason_codes: ['POLICY_ENGINE_UNAVAILABLE'],
        obligations: [],
        policy: { policy_id: SYNTHETIC_POLICY_ID },
      });

      // The deny is snapshotted (audit trail) and the ops event is appended.
      const snapshot = await pool.query<{ decision: string; reason_codes: string[] }>(
        `SELECT decision, reason_codes FROM eligibility.mode_decisions WHERE decision_id = $1`,
        [body.decision_id],
      );
      expect(snapshot.rows[0]?.decision).toBe('deny');
      expect(snapshot.rows[0]?.reason_codes).toEqual(['POLICY_ENGINE_UNAVAILABLE']);
      const events = await pool.query<{
        event_type: string;
        reason: string;
        metadata: { mode: string; decision_id: string } | null;
      }>(
        `SELECT event_type, reason, metadata FROM eligibility.policy_events
         WHERE account_id = $1 AND event_type = 'evaluation_failure'`,
        [account.accountId],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({
        event_type: 'evaluation_failure',
        reason: 'POLICY_ENGINE_UNAVAILABLE',
      });
      expect(events.rows[0]?.metadata?.mode).toBe('friends');
      expect(events.rows[0]?.metadata?.decision_id).toBe(body.decision_id);
    } finally {
      await closeApiApp(deadApp);
    }
  });
});

describe('effective-time policy history', () => {
  const V1_ID = '33f0a6a0-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
  const V2_ID = '44f0a6a0-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
  let started: StartedInfra;
  let pool: Pool;
  let baseUrl: string;
  let api: ApiApp;

  beforeAll(async () => {
    const harness = await startEligibilityHarness({ seedPolicy: false, opa: true });
    started = harness.started;
    pool = harness.pool;
    baseUrl = harness.baseUrl;
    api = harness.api;
    // Disjoint windows: v1 covers 2025-01-01 → 2026-05-31T23:59:59Z, v2
    // covers 2026-06-01T00:00:00Z → open. The selector's findActive is
    // unordered, so overlapping intervals must never occur.
    const v1Content = syntheticPolicyDocument({ policy_id: V1_ID, revision: 1 });
    const v2Content = syntheticPolicyDocument({ policy_id: V2_ID, revision: 2 });
    await insertApprovedPolicy(harness.db, {
      id: V1_ID,
      jurisdictionKey: 'US',
      revision: 1,
      document: v1Content,
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveUntil: new Date('2026-05-31T23:59:59.000Z'),
    });
    await insertApprovedPolicy(harness.db, {
      id: V2_ID,
      jurisdictionKey: 'US',
      revision: 2,
      document: v2Content,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      effectiveUntil: Infinity,
    });
  }, 180_000);

  afterAll(async () => {
    await stopEligibilityHarness({ api, started, pool });
  });

  async function setupHistoryAccount(): Promise<string> {
    const account = await registerAndLogin(baseUrl, freshEmail());
    const declared = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'US' },
      account.cookie,
    );
    expect(declared.status).toBe(200);
    const aged = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: '2000-06-15' },
      account.cookie,
    );
    expect(aged.status).toBe(200);
    return account.cookie;
  }

  async function evaluateAt(
    cookie: string,
    effectiveAt: string,
    idempotencyKey?: string,
  ): Promise<{ status: number; body: EvaluationBody }> {
    const response = await postJson(
      baseUrl,
      '/v1/eligibility/mode-evaluations',
      {
        mode: 'events',
        effective_at: effectiveAt,
        ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      },
      cookie,
    );
    return { status: response.status, body: (await response.json()) as EvaluationBody };
  }

  it('rejects historical instants that predate the account declaration', async () => {
    const cases: Array<{
      effectiveAt: string;
      status: number;
      revision?: number;
      message?: string;
    }> = [
      // Before the first policy exists.
      {
        effectiveAt: '2024-12-31T12:00:00.000Z',
        status: 400,
        message: 'no_active_jurisdiction_policy',
      },
      {
        effectiveAt: '2025-01-01T00:00:00.000Z',
        status: 400,
        message: 'no_active_jurisdiction_policy',
      },
      {
        effectiveAt: '2026-03-01T12:00:00.000Z',
        status: 400,
        message: 'no_active_jurisdiction_policy',
      },
      // Exactly at v1 end — outside (interval is [from, until)).
      {
        effectiveAt: '2026-05-31T23:59:59.000Z',
        status: 400,
        message: 'no_active_jurisdiction_policy',
      },
      // In the 1-second gap between revisions.
      {
        effectiveAt: '2026-05-31T23:59:59.500Z',
        status: 400,
        message: 'no_active_jurisdiction_policy',
      },
      {
        effectiveAt: '2026-06-01T00:00:00.000Z',
        status: 400,
        message: 'no_active_jurisdiction_policy',
      },
      {
        effectiveAt: '2026-07-01T12:00:00.000Z',
        status: 400,
        message: 'no_active_jurisdiction_policy',
      },
    ];
    for (const c of cases) {
      const cookie = await setupHistoryAccount();
      const { status, body } = await evaluateAt(cookie, c.effectiveAt);
      expect(status, c.effectiveAt).toBe(c.status);
      if (c.status === 200) {
        expect((body as ModeResponse).policy.revision, c.effectiveAt).toBe(c.revision);
      } else {
        expect((body as { message: string }).message, c.effectiveAt).toBe(c.message);
      }
    }
  });

  it('rejects an effective instant beyond the skew window', async () => {
    const cookie = await setupHistoryAccount();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { status, body } = await evaluateAt(cookie, future);
    expect(status).toBe(400);
    expect((body as { message: string }).message).toBe('effective_at_in_future');
  });

  it('never creates a snapshot from a declaration and credential issued later', async () => {
    const cookie = await setupHistoryAccount();
    const oldRequest = {
      mode: 'events',
      effective_at: '2026-03-01T12:00:00.000Z',
      idempotency_key: 'k-history-replay',
    };
    const first = await evaluateAt(cookie, oldRequest.effective_at, oldRequest.idempotency_key);
    expect(first.status).toBe(400);
    expect((first.body as { message: string }).message).toBe('no_active_jurisdiction_policy');

    const newer = await evaluateAt(cookie, '2026-07-01T12:00:00.000Z', oldRequest.idempotency_key);
    expect(newer.status).toBe(400);
    expect((newer.body as { message: string }).message).toBe('no_active_jurisdiction_policy');
    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eligibility.mode_decisions`,
    );
    expect(rows.rows[0]?.n).toBe('0');
  });
});
