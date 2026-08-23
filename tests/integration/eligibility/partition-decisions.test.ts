import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AppConfig } from '@wai/config';
import type { StartedInfra, StartedOpa } from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import {
  PartitionDecisionService,
  type PartitionDecisionView,
} from '../../../apps/api/src/eligibility/services/partition-decision.service.js';
import {
  putJson,
  registerAndLogin,
  startEligibilityHarness,
  stopEligibilityHarness,
  type ApiApp,
} from './helpers.js';
import { SYNTHETIC_POLICY_ID, insertApprovedPolicy, syntheticPolicyDocument } from './seed.js';

/**
 * CP6 evidence over real Postgres + Valkey + the REAL OPA container: the
 * two-party partition vertical (task book §7 internal port — never a public
 * query API). Youth↔Adult is denied across all five capabilities (the
 * CROSS_COHORT_DENIED invariant), the dating hard gate requires both sides
 * adult (18 / policy minimum / assurance), same-cohort youth contact is
 * allowed under the policy matrix, replays resolve to the stored immutable
 * snapshot, and an unreachable engine degrades into a deny snapshot plus an
 * evaluation_failure event.
 */

const NON_DATING_CAPABILITIES = [
  'discover',
  'introduce',
  'direct_message',
  'event_visibility',
] as const;
const DE_POLICY_ID = '55f0a6a0-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
const FR_POLICY_ID = '66f0a6a0-6b8e-4b1a-9f3a-8c9d1e2f3a4b';

let emailSeq = 0;

function freshEmail(): string {
  emailSeq += 1;
  return `partition-decisions-${emailSeq}@example.invalid`;
}

/** A credential cannot be used before it was issued; evaluate just after issuance. */
function anHourAgo(): string {
  return new Date().toISOString();
}

async function expectRejected(
  promise: Promise<unknown>,
  status: number,
  message: string,
): Promise<void> {
  const caught = await promise.catch((error: unknown) => error);
  const http = caught as {
    getStatus?: () => number;
    getResponse?: () => { message?: string };
  };
  expect(http.getStatus?.()).toBe(status);
  expect(http.getResponse?.().message).toBe(message);
}

describe('cross-partition compliance over the real policy engine', () => {
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
    // DE: dating mode minimum 21 — both parties adult, one below the gate.
    const deBase = syntheticPolicyDocument({ policy_id: DE_POLICY_ID });
    await insertApprovedPolicy(harness.db, {
      id: DE_POLICY_ID,
      jurisdictionKey: 'DE',
      revision: 1,
      document: {
        ...deBase,
        mode_rules: {
          ...deBase.mode_rules,
          mode_minimum_age: { ...deBase.mode_rules.mode_minimum_age, dating: 21 },
        },
      },
      effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
      effectiveUntil: Infinity,
    });
    // FR: dating requires externally attested assurance — the API can only
    // issue self_declared credentials today, so both sides fail the gate.
    const frBase = syntheticPolicyDocument({ policy_id: FR_POLICY_ID });
    await insertApprovedPolicy(harness.db, {
      id: FR_POLICY_ID,
      jurisdictionKey: 'FR',
      revision: 1,
      document: {
        ...frBase,
        mode_rules: {
          ...frBase.mode_rules,
          required_age_assurance_by_mode: {
            ...frBase.mode_rules.required_age_assurance_by_mode,
            dating: 'externally_attested',
          },
        },
      },
      effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
      effectiveUntil: Infinity,
    });
  }, 180_000);

  afterAll(async () => {
    await stopEligibilityHarness({ api, started, pool, ...(opa === undefined ? {} : { opa }) });
  });

  async function setupParty(
    birthDate: string,
    jurisdiction: { countryCode: string; subdivisionCode?: string } = { countryCode: 'US' },
  ): Promise<{ accountId: string; cookie: string }> {
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
    return account;
  }

  function decide(
    actor: string,
    subject: string,
    body: { capability: string; effective_at?: string },
  ): Promise<PartitionDecisionView> {
    const service = api.get(PartitionDecisionService);
    return service.decide(actor, subject, {
      capability: body.capability as PartitionDecisionView['capability'],
      ...(body.effective_at === undefined ? {} : { effective_at: body.effective_at }),
    });
  }

  it('denies a youth actor against an adult subject on all five capabilities', async () => {
    const youth = await setupParty('2010-06-15'); // 16 — youth_16
    const adult = await setupParty('2000-06-15'); // 26 — adult
    const effectiveAt = anHourAgo();

    for (const capability of NON_DATING_CAPABILITIES) {
      const view = await decide(youth.accountId, adult.accountId, {
        capability,
        effective_at: effectiveAt,
      });
      expect(view.decision, capability).toBe('deny');
      expect(view.reason_codes, capability).toEqual(['CROSS_COHORT_DENIED']);
      expect(view.actor_cohort_key).toBe('youth_16');
      expect(view.subject_cohort_key).toBe('adult');
      expect(view.actor_policy.policy_id).toBe(SYNTHETIC_POLICY_ID);
      expect(view.subject_policy.policy_id).toBe(SYNTHETIC_POLICY_ID);
    }

    // Dating adds the adult threshold on the youth side — the fixed order
    // lists it before the cross-partition code.
    const dating = await decide(youth.accountId, adult.accountId, {
      capability: 'dating',
      effective_at: effectiveAt,
    });
    expect(dating.decision).toBe('deny');
    expect(dating.reason_codes).toEqual(['ADULT_THRESHOLD_NOT_MET', 'CROSS_COHORT_DENIED']);
  });

  it('denies an adult actor against a youth subject (cross-partition is symmetric)', async () => {
    const adult = await setupParty('2000-06-15');
    const youth = await setupParty('2010-06-15');
    const view = await decide(adult.accountId, youth.accountId, {
      capability: 'direct_message',
      effective_at: anHourAgo(),
    });
    expect(view.decision).toBe('deny');
    expect(view.reason_codes).toEqual(['CROSS_COHORT_DENIED']);
  });

  it('allows same-cohort youth contact (discover) under the same_cohort_only matrix', async () => {
    const first = await setupParty('2010-06-15'); // 16
    const second = await setupParty('2010-06-15'); // 16 — same cohort
    const view = await decide(first.accountId, second.accountId, {
      capability: 'discover',
      effective_at: anHourAgo(),
    });
    expect(view.decision).toBe('allow');
    expect(view.reason_codes).toEqual([]);
    expect(view.actor_cohort_key).toBe('youth_16');
    expect(view.subject_cohort_key).toBe('youth_16');
  });

  it('denies different youth cohorts under the same_cohort_only matrix', async () => {
    const first = await setupParty('2010-06-15'); // 16
    const second = await setupParty('2009-06-15'); // 17 — adjacent, but the policy says same cohort only
    const view = await decide(first.accountId, second.accountId, {
      capability: 'discover',
      effective_at: anHourAgo(),
    });
    expect(view.decision).toBe('deny');
    expect(view.reason_codes).toEqual(['CROSS_COHORT_DENIED']);
  });

  it('rejects a subject without an age declaration and a future effective instant', async () => {
    const actor = await setupParty('2000-06-15');
    const bare = await registerAndLogin(baseUrl, freshEmail());
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, bare.cookie);
    await expectRejected(
      decide(actor.accountId, bare.accountId, { capability: 'discover' }),
      400,
      'age_declaration_required',
    );

    const subject = await setupParty('2000-06-15');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await expectRejected(
      decide(actor.accountId, subject.accountId, {
        capability: 'discover',
        effective_at: future,
      }),
      400,
      'effective_at_in_future',
    );
  });

  it('replays an identical request from the stored snapshot; a different capability is a different decision', async () => {
    const actor = await setupParty('2000-06-15');
    const subject = await setupParty('2000-06-15');
    const effectiveAt = anHourAgo();

    const first = await decide(actor.accountId, subject.accountId, {
      capability: 'discover',
      effective_at: effectiveAt,
    });
    expect(first.decision).toBe('allow');
    const replay = await decide(actor.accountId, subject.accountId, {
      capability: 'discover',
      effective_at: effectiveAt,
    });
    expect(replay).toEqual(first);

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eligibility.partition_decisions WHERE decision_id = $1`,
      [first.decision_id],
    );
    expect(count.rows[0]?.n).toBe('1');
    const stored = await pool.query<{
      decision: string;
      actor_cohort_key: string;
      subject_cohort_key: string;
    }>(
      `SELECT decision, actor_cohort_key, subject_cohort_key
       FROM eligibility.partition_decisions WHERE decision_id = $1`,
      [first.decision_id],
    );
    expect(stored.rows[0]).toEqual({
      decision: 'allow',
      actor_cohort_key: 'adult',
      subject_cohort_key: 'adult',
    });

    const other = await decide(actor.accountId, subject.accountId, {
      capability: 'dating',
      effective_at: effectiveAt,
    });
    expect(other.decision_id).not.toBe(first.decision_id);
  });

  it('fails closed with a deny snapshot and an evaluation_failure event when OPA is unreachable', async () => {
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
      // Accounts are created through the dead app's HTTP surface (its
      // eligibility routes never touch the engine); the partition decision
      // then runs its engine call into the dead port.
      const actor = await registerAndLogin(deadBaseUrl, freshEmail());
      await putJson(
        deadBaseUrl,
        '/v1/eligibility/jurisdiction',
        { country_code: 'US' },
        actor.cookie,
      );
      await putJson(
        deadBaseUrl,
        '/v1/eligibility/age-declaration',
        { birth_date: '2000-06-15' },
        actor.cookie,
      );
      const subject = await registerAndLogin(deadBaseUrl, freshEmail());
      await putJson(
        deadBaseUrl,
        '/v1/eligibility/jurisdiction',
        { country_code: 'US' },
        subject.cookie,
      );
      await putJson(
        deadBaseUrl,
        '/v1/eligibility/age-declaration',
        { birth_date: '2000-06-15' },
        subject.cookie,
      );

      const view = await deadApp
        .get(PartitionDecisionService)
        .decide(actor.accountId, subject.accountId, {
          capability: 'dating',
          effective_at: anHourAgo(),
        });
      expect(view.decision).toBe('deny');
      expect(view.reason_codes).toEqual(['POLICY_ENGINE_UNAVAILABLE']);

      const snapshot = await pool.query<{ decision: string; reason_codes: string[] }>(
        `SELECT decision, reason_codes FROM eligibility.partition_decisions WHERE decision_id = $1`,
        [view.decision_id],
      );
      expect(snapshot.rows[0]?.decision).toBe('deny');
      expect(snapshot.rows[0]?.reason_codes).toEqual(['POLICY_ENGINE_UNAVAILABLE']);
      const events = await pool.query<{
        event_type: string;
        reason: string;
        metadata: { capability: string; decision_id: string } | null;
      }>(
        `SELECT event_type, reason, metadata FROM eligibility.policy_events
         WHERE account_id = $1 AND event_type = 'evaluation_failure'`,
        [actor.accountId],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({
        event_type: 'evaluation_failure',
        reason: 'POLICY_ENGINE_UNAVAILABLE',
      });
      expect(events.rows[0]?.metadata?.capability).toBe('dating');
      expect(events.rows[0]?.metadata?.decision_id).toBe(view.decision_id);
    } finally {
      await closeApiApp(deadApp);
    }
  });

  it('enforces the dating hard gate matrix: 18 allowed, under-18 denied, 21-mode-minimum, assurance', async () => {
    // Both adult — dating allowed.
    const adultA = await setupParty('2000-06-15');
    const adultB = await setupParty('1998-06-15');
    const allowed = await decide(adultA.accountId, adultB.accountId, {
      capability: 'dating',
      effective_at: anHourAgo(),
    });
    expect(allowed.decision).toBe('allow');
    expect(allowed.reason_codes).toEqual([]);

    // Exactly 18 — the dating floor is max(18, majority 18) = 18.
    const exactly18 = await setupParty('2008-06-15');
    const at18 = await decide(exactly18.accountId, adultB.accountId, {
      capability: 'dating',
      effective_at: anHourAgo(),
    });
    expect(at18.decision).toBe('allow');

    // A 17-year-old never dates, whatever the other side is.
    const youth17 = await setupParty('2009-06-15');
    const at17 = await decide(youth17.accountId, adultB.accountId, {
      capability: 'dating',
      effective_at: anHourAgo(),
    });
    expect(at17.decision).toBe('deny');
    expect(at17.reason_codes).toEqual(['ADULT_THRESHOLD_NOT_MET', 'CROSS_COHORT_DENIED']);

    // Both adult but one side below the policy's 21 dating minimum (DE).
    const de18 = await setupParty('2008-06-15', { countryCode: 'DE' });
    const de21 = await setupParty('2005-06-15', { countryCode: 'DE' });
    const below21 = await decide(de18.accountId, de21.accountId, {
      capability: 'dating',
      effective_at: anHourAgo(),
    });
    expect(below21.decision).toBe('deny');
    expect(below21.reason_codes).toEqual(['ADULT_THRESHOLD_NOT_MET']);
    expect(below21.actor_policy.policy_id).toBe(DE_POLICY_ID);

    // Dating under FR requires externally attested assurance on both sides;
    // the public API only issues self_declared credentials.
    const frA = await setupParty('2000-06-15', { countryCode: 'FR' });
    const frB = await setupParty('1998-06-15', { countryCode: 'FR' });
    const unassured = await decide(frA.accountId, frB.accountId, {
      capability: 'dating',
      effective_at: anHourAgo(),
    });
    expect(unassured.decision).toBe('deny');
    expect(unassured.reason_codes).toEqual(['AGE_ASSURANCE_REQUIRED']);
    expect(unassured.actor_policy.policy_id).toBe(FR_POLICY_ID);
  });
});
