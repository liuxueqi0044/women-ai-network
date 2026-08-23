import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  AgeCredentialRepository,
  AgeCredentialRow,
  AgeEvidenceRepository,
  AgeEvidenceRow,
  JurisdictionDeclarationRepository,
  JurisdictionDeclarationRow,
  ModeDecisionRepository,
  ModeDecisionRow,
  PolicyEventRepository,
} from '@wai/db';
import {
  OPEN_ENDED,
  decisionIdSchema,
  type AgeModePolicyDecisionPort,
  type DecisionOutput,
  type JurisdictionPolicySelection,
  type JurisdictionPolicySelector,
  type ModeDecisionInput,
  type PolicyDocument,
} from '@wai/contracts';
import type { BirthdayCipher } from '../infra/eligibility-secret-cipher.js';
import type { ElgClock } from '../infra/elg-clock.js';
import { ModeEvaluationService } from './mode-evaluation.service.js';

const ACCOUNT_ID = 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const POLICY_ID = '11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
const CREDENTIAL_ID = 'c1d2e3f4-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const NOW = new Date('2026-08-17T02:00:00.000Z');
const POLICY_HASH = 'c'.repeat(64);
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function basePolicyDocument(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  const allModes = ['friends', 'activities', 'professional', 'circles', 'events', 'dating'];
  return {
    policy_id: POLICY_ID,
    revision: 1,
    minimum_account_age: 13,
    age_of_majority: 18,
    digital_consent_age: 16,
    parental_consent_required_below: 16,
    youth_launch_state: 'launched',
    allowed_cohorts: ['youth_13', 'youth_14', 'youth_15', 'youth_16', 'youth_17', 'adult'],
    cross_cohort_contact_policy: 'same_cohort_only',
    mode_rules: {
      mode_enabled: Object.fromEntries(allModes.map((mode) => [mode, true])) as Record<
        string,
        boolean
      >,
      platform_minimum_age_by_mode: Object.fromEntries(
        allModes.map((mode) => [mode, 13]),
      ) as Record<string, number>,
      mode_minimum_age: Object.fromEntries(allModes.map((mode) => [mode, 0])) as Record<
        string,
        number
      >,
      required_age_assurance_by_mode: Object.fromEntries(
        allModes.map((mode) => [mode, 'self_declared']),
      ) as Record<string, 'self_declared'>,
    },
    ...overrides,
  };
}

function selection(
  overrides: Partial<JurisdictionPolicySelection> = {},
): JurisdictionPolicySelection {
  return {
    policy_id: POLICY_ID,
    jurisdiction_key: 'US',
    revision: 1,
    timezone: 'America/New_York',
    effective_from: '2025-01-01T00:00:00.000Z',
    effective_until: OPEN_ENDED,
    content_hash: POLICY_HASH,
    document: basePolicyDocument(),
    ...overrides,
  };
}

function credentialRow(overrides: Partial<AgeCredentialRow> = {}): AgeCredentialRow {
  return {
    id: CREDENTIAL_ID,
    accountId: ACCOUNT_ID,
    // Deliberately stale derived facts — the service must recompute the
    // subject from the decrypted birthday, never trust these.
    ageBand: 'adult',
    cohortKey: 'adult',
    assuranceLevel: 'self_declared',
    issuerType: 'eligibility_self_declaration',
    sourceEvidenceId: 'evidence-1',
    jurisdictionPolicyId: POLICY_ID,
    jurisdictionKey: 'US',
    policyRevision: 1,
    validFrom: new Date('2025-01-01T00:00:00.000Z'),
    validUntil: Infinity,
    supersededAt: null,
    derivedAt: new Date('2026-08-01T00:00:00.000Z'),
    derivationVersion: 1,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function evidenceRow(overrides: Partial<AgeEvidenceRow> = {}): AgeEvidenceRow {
  return {
    id: 'evidence-1',
    accountId: ACCOUNT_ID,
    birthdayDigest: 'd'.repeat(64),
    birthdayCiphertext: 'ciphertext',
    birthdayNonce: 'nonce',
    birthdayKeyId: 'dev-key',
    source: 'self_declared',
    declaredAt: new Date('2026-08-01T00:00:00.000Z'),
    supersededAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function expectHttpException(
  caught: unknown,
  status: number,
  code: string,
  message?: string,
): void {
  expect(caught).toBeInstanceOf(HttpException);
  const http = caught as HttpException;
  expect(http.getStatus()).toBe(status);
  const response = http.getResponse() as { code?: string; message?: string };
  expect(response.code).toBe(code);
  if (message !== undefined) {
    expect(response.message).toBe(message);
  }
}

async function expectRejected(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
): Promise<void> {
  const caught = await promise.catch((error: unknown) => error);
  expectHttpException(caught, status, code, message);
}

class FakeDeclarationRepository implements Pick<JurisdictionDeclarationRepository, 'current'> {
  currentRow: JurisdictionDeclarationRow | null = null;

  async current(): Promise<JurisdictionDeclarationRow | null> {
    return this.currentRow;
  }
}

class FakeEvidenceRepository implements Pick<AgeEvidenceRepository, 'current'> {
  currentRow: AgeEvidenceRow | null = null;

  async current(): Promise<AgeEvidenceRow | null> {
    return this.currentRow;
  }
}

class FakeCredentialRepository implements Pick<AgeCredentialRepository, 'current'> {
  currentRow: AgeCredentialRow | null = null;

  async current(): Promise<AgeCredentialRow | null> {
    return this.currentRow;
  }
}

class FakeSelector implements JurisdictionPolicySelector {
  selection: JurisdictionPolicySelection | null = null;
  calls: Array<{ accountId: string; effectiveAt: string }> = [];

  async select(
    accountId: string,
    effectiveAt: string,
  ): Promise<JurisdictionPolicySelection | null> {
    this.calls.push({ accountId, effectiveAt });
    return this.selection;
  }
}

class FakeCipher implements BirthdayCipher {
  birthDate = '2010-06-15';
  decryptCalls: Array<{ ciphertext: string; nonce: string; keyId: string }> = [];

  encrypt(): never {
    throw new Error('not used in these tests');
  }
  decrypt(encrypted: { ciphertext: string; nonce: string; keyId: string }): string {
    this.decryptCalls.push(encrypted);
    return this.birthDate;
  }
  activeKeyId(): string {
    return 'dev-key';
  }
}

class FakeDecisionRepository implements ModeDecisionRepository {
  stored = new Map<string, ModeDecisionRow>();
  inserts = 0;

  async insertIfAbsent(row: ModeDecisionRow): Promise<{ row: ModeDecisionRow; inserted: boolean }> {
    const existing = this.stored.get(row.decisionId);
    if (existing !== undefined) {
      return { row: existing, inserted: false };
    }
    this.stored.set(row.decisionId, row);
    this.inserts += 1;
    return { row, inserted: true };
  }
  async findByDecisionId(decisionId: string): Promise<ModeDecisionRow | null> {
    return this.stored.get(decisionId) ?? null;
  }
  async findDefaultedByIdempotencyKey(
    accountId: string,
    key: string,
    mode: ModeDecisionRow['mode'],
  ): Promise<ModeDecisionRow | null> {
    return (
      [...this.stored.values()].find(
        (row) =>
          row.accountId === accountId &&
          row.idempotencyKey === key &&
          row.mode === mode &&
          row.effectiveAtDefaulted === true,
      ) ?? null
    );
  }
}

class FakeEventRepository implements Pick<PolicyEventRepository, 'append'> {
  events: Array<{
    eventType: string;
    policyId?: string;
    jurisdictionKey?: string;
    accountId?: string;
    reason?: string;
    metadata: Record<string, unknown>;
  }> = [];

  async append(input: {
    eventType: string;
    policyId?: string;
    jurisdictionKey?: string;
    accountId?: string;
    reason?: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    this.events.push(input);
  }
}

class FakeDecider implements AgeModePolicyDecisionPort {
  output: DecisionOutput = { decision: 'allow', reason_codes: [], obligations: [] };
  inputs: ModeDecisionInput[] = [];

  async decide(input: ModeDecisionInput): Promise<DecisionOutput> {
    this.inputs.push(input);
    return this.output;
  }
}

function makeService() {
  const declarations = new FakeDeclarationRepository();
  const evidence = new FakeEvidenceRepository();
  const credentials = new FakeCredentialRepository();
  const decisions = new FakeDecisionRepository();
  const events = new FakeEventRepository();
  const selector = new FakeSelector();
  const cipher = new FakeCipher();
  const decider = new FakeDecider();
  let currentNow = NOW;
  const clock: ElgClock = { now: () => currentNow };
  const service = new ModeEvaluationService(
    {
      jurisdictionDeclarations: declarations,
      ageEvidence: evidence,
      ageCredentials: credentials,
      modeDecisions: decisions,
      policyEvents: events,
    },
    selector,
    cipher,
    clock,
    decider,
  );
  return {
    service,
    declarations,
    evidence,
    credentials,
    decisions,
    events,
    selector,
    cipher,
    decider,
    setNow: (value: Date) => {
      currentNow = value;
    },
  };
}

/** State in which a mode evaluation reaches the decision engine. */
function readyState(harness: ReturnType<typeof makeService>): void {
  harness.declarations.currentRow = {
    id: 'd0e9f8a7-6b5c-4d3e-2f1a-0b9c8d7e6f5a',
    accountId: ACCOUNT_ID,
    countryCode: 'US',
    subdivisionCode: null,
    source: 'self_declared',
    reviewState: 'accepted',
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    supersededAt: null,
    version: 1,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  harness.selector.selection = selection();
  harness.credentials.currentRow = credentialRow();
  harness.evidence.currentRow = evidenceRow();
}

describe('ModeEvaluationService.evaluate — preconditions', () => {
  it('rejects missing jurisdiction, review state, active policy, credential', async () => {
    const h = makeService();
    await expectRejected(
      h.service.evaluate(ACCOUNT_ID, { mode: 'friends' }),
      400,
      'VALIDATION_ERROR',
      'jurisdiction_required',
    );

    h.declarations.currentRow = {
      id: 'd0e9f8a7-6b5c-4d3e-2f1a-0b9c8d7e6f5a',
      accountId: ACCOUNT_ID,
      countryCode: 'US',
      subdivisionCode: null,
      source: 'self_declared',
      reviewState: 'conflict_review_required',
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
      supersededAt: null,
      version: 1,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    await expectRejected(
      h.service.evaluate(ACCOUNT_ID, { mode: 'friends' }),
      400,
      'VALIDATION_ERROR',
      'jurisdiction_review_required',
    );

    h.declarations.currentRow = { ...h.declarations.currentRow, reviewState: 'accepted' };
    await expectRejected(
      h.service.evaluate(ACCOUNT_ID, { mode: 'friends' }),
      400,
      'VALIDATION_ERROR',
      'no_active_jurisdiction_policy',
    );

    h.selector.selection = selection();
    await expectRejected(
      h.service.evaluate(ACCOUNT_ID, { mode: 'friends' }),
      400,
      'VALIDATION_ERROR',
      'age_declaration_required',
    );

    h.credentials.currentRow = credentialRow();
    h.evidence.currentRow = null;
    await expect(h.service.evaluate(ACCOUNT_ID, { mode: 'friends' })).rejects.toThrow(
      /credential without current evidence/,
    );
  });

  it('rejects a client-supplied effective_at beyond clock skew', async () => {
    const h = makeService();
    readyState(h);
    await expectRejected(
      h.service.evaluate(ACCOUNT_ID, {
        mode: 'friends',
        effective_at: '2026-08-17T02:10:00.000Z',
      }),
      400,
      'VALIDATION_ERROR',
      'effective_at_in_future',
    );
  });

  it('defaults effective_at to the clock instant', async () => {
    const h = makeService();
    readyState(h);
    await h.service.evaluate(ACCOUNT_ID, { mode: 'friends' });
    expect(h.decider.inputs[0]?.request.effective_at).toBe(NOW.toISOString());
  });

  it('reuses the first effective instant when an omitted effective_at is retried', async () => {
    const h = makeService();
    readyState(h);
    const first = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      idempotency_key: 'k-stable-1',
    });
    h.setNow(new Date('2026-08-16T12:05:00.000Z'));
    const second = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      idempotency_key: 'k-stable-1',
    });
    expect(second.decision_id).toBe(first.decision_id);
    expect(h.decider.inputs).toHaveLength(1);
  });

  it('does not reuse a defaulted snapshot when the same key is used for another mode', async () => {
    const h = makeService();
    readyState(h);
    const first = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      idempotency_key: 'k-stable-2',
    });
    h.setNow(new Date('2026-08-16T12:05:00.000Z'));
    const second = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'events',
      idempotency_key: 'k-stable-2',
    });
    expect(second.mode).toBe('events');
    expect(second.decision_id).not.toBe(first.decision_id);
    expect(h.decider.inputs).toHaveLength(2);
  });
});

describe('ModeEvaluationService.evaluate — allow path', () => {
  it('recomputes age in the policy timezone, evaluates and snapshots', async () => {
    const h = makeService();
    readyState(h);
    // 2010-06-15 in America/New_York at 2026-08-16T12:00Z is 16 — the stale
    // adult credential facts on the row must NOT leak into the subject.
    const response = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      effective_at: '2026-08-16T12:00:00.000Z',
      idempotency_key: 'k-12345678',
    });

    expect(response.decision).toBe('allow');
    expect(response.reason_codes).toEqual([]);
    expect(response.mode).toBe('friends');
    expect(response.age_band).toBe('youth');
    expect(response.cohort_key).toBe('youth_16');
    expect(response.assurance_level).toBe('self_declared');
    expect(response.policy).toEqual({
      policy_id: POLICY_ID,
      revision: 1,
      policy_hash: POLICY_HASH,
    });
    expect(response.credential).toEqual({
      credential_id: CREDENTIAL_ID,
      assurance_level: 'self_declared',
    });
    expect(response.evaluated_at).toBe('2026-08-16T12:00:00.000Z');
    expect(response.valid_until).toBe(OPEN_ENDED);
    expect(response.decision_id).toMatch(UUID_V5);

    const input = h.decider.inputs[0];
    expect(input).toBeDefined();
    expect(input?.subject).toEqual({
      age_years: 16,
      age_band: 'youth',
      cohort_key: 'youth_16',
      assurance_level: 'self_declared',
    });
    expect(input?.request).toEqual({ mode: 'friends', effective_at: '2026-08-16T12:00:00.000Z' });

    const row = h.decisions.stored.get(response.decision_id);
    expect(row).toMatchObject({
      accountId: ACCOUNT_ID,
      scope: 'age_and_jurisdiction',
      decision: 'allow',
      mode: 'friends',
      ageBand: 'youth',
      cohortKey: 'youth_16',
      assuranceLevel: 'self_declared',
      reasonCodes: [],
      obligations: [],
      policyId: POLICY_ID,
      policyRevision: 1,
      policyHash: POLICY_HASH,
      credentialId: CREDENTIAL_ID,
      engineVersion: 1,
    });
    expect(row?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.events.events).toEqual([]);
    // The birth date is decrypted for arithmetic but never serialized.
    expect(JSON.stringify(response)).not.toContain('2010-06-15');
  });

  it('computes the local calendar date in the policy timezone (birthday boundary)', async () => {
    const h = makeService();
    readyState(h);
    // 2026-06-14T23:30Z is still June 14 in New York → 15 years old.
    await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      effective_at: '2026-06-14T23:30:00.000Z',
    });
    // 2026-06-15T04:30Z is June 15 in New York → 16 years old.
    await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      effective_at: '2026-06-15T04:30:00.000Z',
    });
    expect(h.decider.inputs[0]?.subject.age_years).toBe(15);
    expect(h.decider.inputs[0]?.subject.cohort_key).toBe('youth_15');
    expect(h.decider.inputs[1]?.subject.age_years).toBe(16);
    expect(h.decider.inputs[1]?.subject.cohort_key).toBe('youth_16');
  });

  it('clamps a negative age (effective instant before birth) to the deny path', async () => {
    const h = makeService();
    readyState(h);
    h.cipher.birthDate = '2005-06-15';
    await expect(
      h.service.evaluate(ACCOUNT_ID, {
        mode: 'friends',
        effective_at: '2005-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/age_credential_not_valid_at_effective_at/);
  });

  it('caps valid_until at the credential window when the policy is open-ended', async () => {
    const h = makeService();
    readyState(h);
    h.credentials.currentRow = credentialRow({ validUntil: new Date('2027-06-30T00:00:00.000Z') });
    const response = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      effective_at: '2026-08-16T12:00:00.000Z',
    });
    expect(response.valid_until).toBe('2027-06-30T00:00:00.000Z');
  });

  it('caps valid_until at the policy window when it ends earlier', async () => {
    const h = makeService();
    readyState(h);
    h.selector.selection = selection({ effective_until: '2026-12-31T00:00:00.000Z' });
    const response = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      effective_at: '2026-08-16T12:00:00.000Z',
    });
    expect(response.valid_until).toBe('2026-12-31T00:00:00.000Z');
  });
});

describe('ModeEvaluationService.evaluate — deny paths', () => {
  it('passes deny reasons and obligations through to the snapshot', async () => {
    const h = makeService();
    readyState(h);
    h.decider.output = {
      decision: 'deny',
      reason_codes: ['PARENTAL_CONSENT_REQUIRED', 'BELOW_MINIMUM_ACCOUNT_AGE'],
      obligations: ['parental_consent_required'],
    };
    const response = await h.service.evaluate(ACCOUNT_ID, { mode: 'dating' });
    expect(response.decision).toBe('deny');
    expect(response.reason_codes).toEqual([
      'PARENTAL_CONSENT_REQUIRED',
      'BELOW_MINIMUM_ACCOUNT_AGE',
    ]);
    expect(response.obligations).toEqual(['parental_consent_required']);
    expect(h.decisions.stored.get(response.decision_id)?.decision).toBe('deny');
    expect(h.events.events).toEqual([]);
  });

  it('records an evaluation_failure event when the engine fails closed', async () => {
    const h = makeService();
    readyState(h);
    h.decider.output = {
      decision: 'deny',
      reason_codes: ['POLICY_ENGINE_UNAVAILABLE'],
      obligations: [],
    };
    const response = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'dating',
      idempotency_key: 'k-engine-down',
    });
    expect(response.decision).toBe('deny');
    expect(response.reason_codes).toEqual(['POLICY_ENGINE_UNAVAILABLE']);
    // The deny is still snapshotted (audit) and the ops trail is appended.
    expect(h.decisions.stored.get(response.decision_id)?.decision).toBe('deny');
    expect(h.events.events).toHaveLength(1);
    expect(h.events.events[0]).toMatchObject({
      eventType: 'evaluation_failure',
      policyId: POLICY_ID,
      jurisdictionKey: 'US',
      accountId: ACCOUNT_ID,
      reason: 'POLICY_ENGINE_UNAVAILABLE',
      metadata: { mode: 'dating', decision_id: response.decision_id },
    });
  });
});

describe('ModeEvaluationService.evaluate — idempotency', () => {
  it('reuses the stored snapshot for identical input (same decision_id, one row)', async () => {
    const h = makeService();
    readyState(h);
    const request = {
      mode: 'friends' as const,
      effective_at: '2026-08-16T12:00:00.000Z',
      idempotency_key: 'k-12345678',
    };
    const first = await h.service.evaluate(ACCOUNT_ID, request);
    const second = await h.service.evaluate(ACCOUNT_ID, request);
    expect(second.decision_id).toBe(first.decision_id);
    expect(second).toEqual(first);
    expect(h.decisions.inserts).toBe(1);
  });

  it('treats a different idempotency key as a distinct logical operation', async () => {
    const h = makeService();
    readyState(h);
    const first = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      effective_at: '2026-08-16T12:00:00.000Z',
      idempotency_key: 'k-aaaaaaaa',
    });
    const second = await h.service.evaluate(ACCOUNT_ID, {
      mode: 'friends',
      effective_at: '2026-08-16T12:00:00.000Z',
      idempotency_key: 'k-bbbbbbbb',
    });
    expect(second.decision_id).not.toBe(first.decision_id);
    expect(h.decisions.inserts).toBe(2);
  });

  it('is deterministic: the same input always yields the same decision id', async () => {
    const h = makeService();
    readyState(h);
    const id = await h.service
      .evaluate(ACCOUNT_ID, { mode: 'events', effective_at: '2026-08-16T12:00:00.000Z' })
      .then((r) => r.decision_id);
    expect(decisionIdSchema.safeParse(id).success).toBe(true);
    expect(id).toBe(
      await h.service
        .evaluate(ACCOUNT_ID, { mode: 'events', effective_at: '2026-08-16T12:00:00.000Z' })
        .then((r) => r.decision_id),
    );
  });
});
