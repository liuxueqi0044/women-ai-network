import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  AgeCredentialRepository,
  AgeCredentialRow,
  AgeEvidenceRepository,
  AgeEvidenceRow,
  JurisdictionDeclarationRepository,
  JurisdictionDeclarationRow,
  PartitionDecisionRepository,
  PartitionDecisionRow,
  PolicyEventRepository,
} from '@wai/db';
import {
  OPEN_ENDED,
  decisionIdSchema,
  type AgePartitionDecisionPort,
  type DecisionOutput,
  type JurisdictionPolicySelection,
  type JurisdictionPolicySelector,
  type PartitionDecisionInput,
  type PolicyDocument,
} from '@wai/contracts';
import type { BirthdayCipher } from '../infra/eligibility-secret-cipher.js';
import type { ElgClock } from '../infra/elg-clock.js';
import { PartitionDecisionService } from './partition-decision.service.js';

const ACTOR_ID = 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const SUBJECT_ID = 'e5f6a7b8-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const POLICY_ID = '11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
const ACTOR_CREDENTIAL_ID = 'c1d2e3f4-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const SUBJECT_CREDENTIAL_ID = 'd2e3f4a5-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const NOW = new Date('2026-08-17T02:00:00.000Z');
const POLICY_HASH = 'c'.repeat(64);
const HEX_64 = /^[0-9a-f]{64}$/;

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

function credentialRow(
  accountId: string,
  overrides: Partial<AgeCredentialRow> = {},
): AgeCredentialRow {
  return {
    id: accountId === ACTOR_ID ? ACTOR_CREDENTIAL_ID : SUBJECT_CREDENTIAL_ID,
    accountId,
    // Deliberately stale derived facts — the service must recompute both
    // sides from the decrypted evidence at the effective instant.
    ageBand: 'youth',
    cohortKey: 'youth_15',
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

function evidenceRow(
  accountId: string,
  ciphertext: string,
  overrides: Partial<AgeEvidenceRow> = {},
): AgeEvidenceRow {
  return {
    id: 'evidence-1',
    accountId,
    birthdayDigest: 'd'.repeat(64),
    birthdayCiphertext: ciphertext,
    birthdayNonce: 'nonce',
    birthdayKeyId: 'dev-key',
    source: 'self_declared',
    declaredAt: new Date('2026-08-01T00:00:00.000Z'),
    supersededAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function declarationRow(accountId: string): JurisdictionDeclarationRow {
  return {
    id: `d0e9f8a7-6b5c-4d3e-2f1a-${accountId.slice(0, 12)}`,
    accountId,
    countryCode: 'US',
    subdivisionCode: null,
    source: 'self_declared',
    reviewState: 'accepted',
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    supersededAt: null,
    version: 1,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
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
  rows = new Map<string, JurisdictionDeclarationRow | null>();

  set(accountId: string, row: JurisdictionDeclarationRow | null): void {
    this.rows.set(accountId, row);
  }

  async current(accountId: string): Promise<JurisdictionDeclarationRow | null> {
    return this.rows.get(accountId) ?? null;
  }
}

class FakeEvidenceRepository implements Pick<AgeEvidenceRepository, 'current'> {
  rows = new Map<string, AgeEvidenceRow | null>();

  set(accountId: string, row: AgeEvidenceRow | null): void {
    this.rows.set(accountId, row);
  }

  async current(accountId: string): Promise<AgeEvidenceRow | null> {
    return this.rows.get(accountId) ?? null;
  }
}

class FakeCredentialRepository implements Pick<AgeCredentialRepository, 'current'> {
  rows = new Map<string, AgeCredentialRow | null>();

  set(accountId: string, row: AgeCredentialRow | null): void {
    this.rows.set(accountId, row);
  }

  async current(accountId: string): Promise<AgeCredentialRow | null> {
    return this.rows.get(accountId) ?? null;
  }
}

class FakeSelector implements JurisdictionPolicySelector {
  selections = new Map<string, JurisdictionPolicySelection | null>();
  calls: Array<{ accountId: string; effectiveAt: string }> = [];

  set(accountId: string, s: JurisdictionPolicySelection | null): void {
    this.selections.set(accountId, s);
  }

  async select(
    accountId: string,
    effectiveAt: string,
  ): Promise<JurisdictionPolicySelection | null> {
    this.calls.push({ accountId, effectiveAt });
    return this.selections.get(accountId) ?? null;
  }
}

class FakeCipher implements BirthdayCipher {
  /** Keyed by the evidence row's ciphertext so each side decrypts its own birthday. */
  birthDates = new Map<string, string>();

  decryptCalls: Array<{ ciphertext: string; nonce: string; keyId: string }> = [];

  encrypt(): never {
    throw new Error('not used in these tests');
  }
  decrypt(encrypted: { ciphertext: string; nonce: string; keyId: string }): string {
    this.decryptCalls.push(encrypted);
    return this.birthDates.get(encrypted.ciphertext) ?? '2010-06-15';
  }
  activeKeyId(): string {
    return 'dev-key';
  }
}

class FakeDecisionRepository implements PartitionDecisionRepository {
  stored = new Map<string, PartitionDecisionRow>();
  inserts = 0;

  async insertIfAbsent(
    row: PartitionDecisionRow,
  ): Promise<{ row: PartitionDecisionRow; inserted: boolean }> {
    const existing = this.stored.get(row.decisionId);
    if (existing !== undefined) {
      return { row: existing, inserted: false };
    }
    this.stored.set(row.decisionId, row);
    this.inserts += 1;
    return { row, inserted: true };
  }
  async findByDecisionId(decisionId: string): Promise<PartitionDecisionRow | null> {
    return this.stored.get(decisionId) ?? null;
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
    now: Date;
  }> = [];

  async append(input: {
    eventType: string;
    policyId?: string;
    jurisdictionKey?: string;
    accountId?: string;
    reason?: string;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<void> {
    this.events.push(input);
  }
}

class FakeDecider implements AgePartitionDecisionPort {
  output: DecisionOutput = { decision: 'allow', reason_codes: [], obligations: [] };
  inputs: PartitionDecisionInput[] = [];

  async decide(input: PartitionDecisionInput): Promise<DecisionOutput> {
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
  const clock: ElgClock = { now: () => NOW };
  const service = new PartitionDecisionService(
    {
      jurisdictionDeclarations: declarations,
      ageEvidence: evidence,
      ageCredentials: credentials,
      partitionDecisions: decisions,
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
  };
}

/** State in which a partition evaluation reaches the decision engine. */
function readyState(harness: ReturnType<typeof makeService>): void {
  harness.declarations.set(ACTOR_ID, declarationRow(ACTOR_ID));
  harness.declarations.set(SUBJECT_ID, declarationRow(SUBJECT_ID));
  harness.selector.set(ACTOR_ID, selection());
  harness.selector.set(SUBJECT_ID, selection());
  harness.credentials.set(ACTOR_ID, credentialRow(ACTOR_ID));
  harness.credentials.set(SUBJECT_ID, credentialRow(SUBJECT_ID));
  harness.evidence.set(ACTOR_ID, evidenceRow(ACTOR_ID, 'actor-evidence-cipher'));
  harness.evidence.set(SUBJECT_ID, evidenceRow(SUBJECT_ID, 'subject-evidence-cipher'));
  // Stored derived facts are deliberately stale: the service must recompute
  // the real ages (30 and 15 at NOW) from the decrypted evidence.
  harness.cipher.birthDates.set('actor-evidence-cipher', '1996-01-15');
  harness.cipher.birthDates.set('subject-evidence-cipher', '2011-06-15');
}

describe('PartitionDecisionService.decide — preconditions', () => {
  it('rejects a missing or unreviewed actor declaration, then policy, credential, evidence', async () => {
    const h = makeService();
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
      400,
      'VALIDATION_ERROR',
      'jurisdiction_required',
    );

    h.declarations.set(ACTOR_ID, {
      ...declarationRow(ACTOR_ID),
      reviewState: 'conflict_review_required',
    });
    h.declarations.set(SUBJECT_ID, declarationRow(SUBJECT_ID));
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
      400,
      'VALIDATION_ERROR',
      'jurisdiction_review_required',
    );

    h.declarations.set(ACTOR_ID, declarationRow(ACTOR_ID));
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
      400,
      'VALIDATION_ERROR',
      'no_active_jurisdiction_policy',
    );

    h.selector.set(ACTOR_ID, selection());
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
      400,
      'VALIDATION_ERROR',
      'age_declaration_required',
    );

    h.credentials.set(ACTOR_ID, credentialRow(ACTOR_ID));
    h.evidence.set(ACTOR_ID, null);
    await expect(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
    ).rejects.toThrow(/credential without current evidence/);
  });

  it('rejects a missing subject declaration, policy or credential', async () => {
    const h = makeService();
    readyState(h);

    h.declarations.set(SUBJECT_ID, null);
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
      400,
      'VALIDATION_ERROR',
      'jurisdiction_required',
    );

    h.declarations.set(SUBJECT_ID, declarationRow(SUBJECT_ID));
    h.selector.set(SUBJECT_ID, null);
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
      400,
      'VALIDATION_ERROR',
      'no_active_jurisdiction_policy',
    );

    h.selector.set(SUBJECT_ID, selection());
    h.credentials.set(SUBJECT_ID, null);
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' }),
      400,
      'VALIDATION_ERROR',
      'age_declaration_required',
    );
  });

  it('rejects a client-supplied effective_at beyond clock skew', async () => {
    const h = makeService();
    readyState(h);
    await expectRejected(
      h.service.decide(ACTOR_ID, SUBJECT_ID, {
        capability: 'discover',
        effective_at: '2026-08-17T02:10:00.000Z',
      }),
      400,
      'VALIDATION_ERROR',
      'effective_at_in_future',
    );
  });

  it('defaults effective_at to the clock instant and selects both policies there', async () => {
    const h = makeService();
    readyState(h);
    await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' });
    expect(h.decider.inputs[0]?.request.effective_at).toBe(NOW.toISOString());
    expect(h.selector.calls).toEqual([
      { accountId: ACTOR_ID, effectiveAt: NOW.toISOString() },
      { accountId: SUBJECT_ID, effectiveAt: NOW.toISOString() },
    ]);
  });
});

describe('PartitionDecisionService.decide — evaluation', () => {
  it('allows an adult/adult discover and persists a complete snapshot', async () => {
    const h = makeService();
    readyState(h);
    const view = await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' });

    expect(view.decision).toBe('allow');
    expect(view.reason_codes).toEqual([]);
    expect(view.actor_age_band).toBe('adult');
    expect(view.actor_cohort_key).toBe('adult');
    expect(view.subject_age_band).toBe('youth');
    expect(view.subject_cohort_key).toBe('youth_15');
    expect(decisionIdSchema.safeParse(view.decision_id).success).toBe(true);
    expect(view.input_hash).toMatch(HEX_64);
    expect(view.actor_policy).toEqual({
      policy_id: POLICY_ID,
      revision: 1,
      policy_hash: POLICY_HASH,
    });
    expect(view.subject_policy).toEqual({
      policy_id: POLICY_ID,
      revision: 1,
      policy_hash: POLICY_HASH,
    });
    expect(view.evaluated_at).toBe(NOW.toISOString());
    expect(view.engine_version).toBe(1);

    const input = h.decider.inputs[0];
    expect(input?.request).toEqual({ capability: 'discover', effective_at: NOW.toISOString() });
    expect(input?.actor).toMatchObject({ age_years: 30, age_band: 'adult', cohort_key: 'adult' });
    expect(input?.subject).toMatchObject({
      age_years: 15,
      age_band: 'youth',
      cohort_key: 'youth_15',
    });

    const row = h.decisions.stored.get(view.decision_id);
    expect(row).toMatchObject({
      decisionId: view.decision_id,
      actorAccountId: ACTOR_ID,
      subjectAccountId: SUBJECT_ID,
      actorAgeBand: 'adult',
      actorCohortKey: 'adult',
      subjectAgeBand: 'youth',
      subjectCohortKey: 'youth_15',
      capability: 'discover',
      decision: 'allow',
      reasonCodes: [],
      actorPolicyId: POLICY_ID,
      subjectPolicyId: POLICY_ID,
      actorPolicyRevision: 1,
      subjectPolicyRevision: 1,
      actorPolicyHash: POLICY_HASH,
      subjectPolicyHash: POLICY_HASH,
      engineVersion: 1,
    });
    expect(row?.evaluatedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('recomputes the subject age from the decrypted evidence at the effective instant', async () => {
    const h = makeService();
    readyState(h);
    h.cipher.birthDates.set('subject-evidence-cipher', '2008-06-15');

    // 2026-06-14T23:30Z is still 17 in America/New_York (birthday is 06-15).
    const before = await h.service.decide(ACTOR_ID, SUBJECT_ID, {
      capability: 'discover',
      effective_at: '2026-06-14T23:30:00.000Z',
    });
    expect(h.decider.inputs[0]?.subject).toMatchObject({
      age_years: 17,
      age_band: 'youth',
      cohort_key: 'youth_17',
    });
    expect(before.subject_cohort_key).toBe('youth_17');

    // 2026-06-15T04:30Z is 18 in America/New_York — the stored credential
    // facts are stale, the recomputed age wins.
    const after = await h.service.decide(ACTOR_ID, SUBJECT_ID, {
      capability: 'discover',
      effective_at: '2026-06-15T04:30:00.000Z',
    });
    expect(h.decider.inputs[1]?.subject).toMatchObject({
      age_years: 18,
      age_band: 'adult',
      cohort_key: 'adult',
    });
    expect(after.subject_cohort_key).toBe('adult');
    expect(after.decision_id).not.toBe(before.decision_id);
  });

  it('passes through a cross-partition deny with its reason codes', async () => {
    const h = makeService();
    readyState(h);
    h.decider.output = { decision: 'deny', reason_codes: ['CROSS_COHORT_DENIED'], obligations: [] };
    const view = await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'direct_message' });

    expect(view.decision).toBe('deny');
    expect(view.reason_codes).toEqual(['CROSS_COHORT_DENIED']);
    expect(h.decisions.stored.get(view.decision_id)?.decision).toBe('deny');
    expect(h.events.events).toEqual([]);
  });

  it('passes through a dating adult-threshold deny', async () => {
    const h = makeService();
    readyState(h);
    h.decider.output = {
      decision: 'deny',
      reason_codes: ['ADULT_THRESHOLD_NOT_MET', 'CROSS_COHORT_DENIED'],
      obligations: [],
    };
    const view = await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'dating' });
    expect(view.decision).toBe('deny');
    expect(view.reason_codes).toEqual(['ADULT_THRESHOLD_NOT_MET', 'CROSS_COHORT_DENIED']);
  });

  it('clamps a negative recomputed age to 0 (effective instant before birth)', async () => {
    const h = makeService();
    readyState(h);
    h.cipher.birthDates.set('subject-evidence-cipher', '2027-01-01');
    const view = await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' });
    expect(h.decider.inputs[0]?.subject).toMatchObject({
      age_years: 0,
      age_band: 'below_minimum',
      cohort_key: 'below_minimum',
    });
    expect(view.subject_cohort_key).toBe('below_minimum');
  });

  it('converts an engine failure into a deny snapshot and an evaluation_failure event', async () => {
    const h = makeService();
    readyState(h);
    h.decider.output = {
      decision: 'deny',
      reason_codes: ['POLICY_ENGINE_UNAVAILABLE'],
      obligations: [],
    };
    const view = await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'direct_message' });

    expect(view.decision).toBe('deny');
    expect(view.reason_codes).toEqual(['POLICY_ENGINE_UNAVAILABLE']);
    expect(h.decisions.stored.get(view.decision_id)?.decision).toBe('deny');
    expect(h.events.events).toEqual([
      {
        eventType: 'evaluation_failure',
        policyId: POLICY_ID,
        jurisdictionKey: 'US',
        accountId: ACTOR_ID,
        reason: 'POLICY_ENGINE_UNAVAILABLE',
        metadata: { capability: 'direct_message', decision_id: view.decision_id },
        now: NOW,
      },
    ]);
  });

  it('replays an identical request from the stored snapshot; a different subject is a different decision', async () => {
    const h = makeService();
    readyState(h);
    const first = await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' });
    const replay = await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' });
    const otherSubject = await h.service.decide(ACTOR_ID, SUBJECT_ID, {
      capability: 'dating',
    });

    expect(replay.decision_id).toBe(first.decision_id);
    expect(replay).toEqual(first);
    // First call inserts; the replay reuses the stored row; the different
    // capability is a genuinely different decision.
    expect(h.decisions.inserts).toBe(2);
    expect(h.decisions.stored.size).toBe(2);
    expect(otherSubject.decision_id).not.toBe(first.decision_id);
  });

  it('never sends account ids or birth dates to the decision engine', async () => {
    const h = makeService();
    readyState(h);
    await h.service.decide(ACTOR_ID, SUBJECT_ID, { capability: 'discover' });

    const inputJson = JSON.stringify(h.decider.inputs[0]);
    expect(inputJson).not.toContain(ACTOR_ID);
    expect(inputJson).not.toContain(SUBJECT_ID);
    expect(inputJson).not.toContain('1996-01-15');
    expect(inputJson).not.toContain('2011-06-15');
    expect(inputJson).not.toContain('actor-evidence-cipher');
    // Both sides' evidence is decrypted transiently to recompute the ages.
    expect(h.cipher.decryptCalls).toHaveLength(2);
  });
});
