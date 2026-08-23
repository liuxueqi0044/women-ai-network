import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  AgeCredentialRepository,
  AgeCredentialRow,
  AgeEvidenceRepository,
  AgeEvidenceRow,
  JurisdictionDeclarationRepository,
  JurisdictionDeclarationRow,
  NewAgeCredential,
  UpsertAgeEvidenceInput,
} from '@wai/db';
import {
  OPEN_ENDED,
  type JurisdictionPolicySelection,
  type JurisdictionPolicySelector,
  type PolicyDocument,
} from '@wai/contracts';
import type { BirthdayCipher, EncryptedBirthday } from '../infra/eligibility-secret-cipher.js';
import type { ElgClock } from '../infra/elg-clock.js';
import { AgeCredentialService } from './age-credential.service.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLICY_ID = '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f';

function fixedClock(atIso: string): ElgClock {
  return { now: () => new Date(atIso) };
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

/** toThrow(function) treats the function as an error class — catch manually. */
async function expectRejected(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
): Promise<void> {
  const caught = await promise.catch((error: unknown) => error);
  expectHttpException(caught, status, code, message);
}

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
    allowed_cohorts: ['youth_13', 'youth_14', 'youth_15', 'youth_16', 'youth_17'],
    cross_cohort_contact_policy: 'same_cohort_only',
    mode_rules: {
      mode_enabled: Object.fromEntries(allModes.map((mode) => [mode, true])) as Record<
        string,
        boolean
      >,
      platform_minimum_age_by_mode: Object.fromEntries(allModes.map((mode) => [mode, 0])) as Record<
        string,
        number
      >,
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
    timezone: 'UTC',
    effective_from: '2025-01-01T00:00:00Z',
    effective_until: OPEN_ENDED,
    content_hash: 'c'.repeat(64),
    document: basePolicyDocument(),
    ...overrides,
  };
}

class FakeDeclarationRepository implements JurisdictionDeclarationRepository {
  currentRow: JurisdictionDeclarationRow | null = null;

  async upsertCurrent(): Promise<JurisdictionDeclarationRow> {
    throw new Error('not used in these tests');
  }
  async current(): Promise<JurisdictionDeclarationRow | null> {
    return this.currentRow;
  }
}

class FakeEvidenceRepository implements AgeEvidenceRepository {
  currentRow: AgeEvidenceRow | null = null;
  upsertInputs: UpsertAgeEvidenceInput[] = [];

  async upsertCurrent(input: UpsertAgeEvidenceInput): Promise<AgeEvidenceRow> {
    this.upsertInputs.push(input);
    if (this.currentRow !== null && this.currentRow.birthdayDigest === input.birthdayDigest) {
      return this.currentRow;
    }
    const row: AgeEvidenceRow = {
      id: input.id,
      accountId: input.accountId,
      birthdayDigest: input.birthdayDigest,
      birthdayCiphertext: input.ciphertext,
      birthdayNonce: input.nonce,
      birthdayKeyId: input.keyId,
      source: 'self_declared',
      declaredAt: input.now,
      supersededAt: null,
      createdAt: input.now,
    };
    this.currentRow = row;
    return row;
  }
  async current(): Promise<AgeEvidenceRow | null> {
    return this.currentRow;
  }
}

class FakeCredentialRepository implements AgeCredentialRepository {
  currentRow: AgeCredentialRow | null = null;
  insertCalls: Array<Omit<NewAgeCredential, 'id' | 'accountId' | 'now'>> = [];

  async insertCurrent(input: NewAgeCredential): Promise<AgeCredentialRow> {
    this.insertCalls.push({
      ageBand: input.ageBand,
      cohortKey: input.cohortKey,
      assuranceLevel: input.assuranceLevel,
      issuerType: input.issuerType,
      sourceEvidenceId: input.sourceEvidenceId,
      jurisdictionPolicyId: input.jurisdictionPolicyId,
      jurisdictionKey: input.jurisdictionKey ?? null,
      policyRevision: input.policyRevision,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      derivedAt: input.derivedAt,
      derivationVersion: input.derivationVersion,
    });
    const row: AgeCredentialRow = {
      id: input.id,
      accountId: input.accountId,
      ageBand: input.ageBand,
      cohortKey: input.cohortKey,
      assuranceLevel: input.assuranceLevel,
      issuerType: input.issuerType,
      sourceEvidenceId: input.sourceEvidenceId,
      jurisdictionPolicyId: input.jurisdictionPolicyId,
      jurisdictionKey: input.jurisdictionKey ?? null,
      policyRevision: input.policyRevision,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      supersededAt: null,
      derivedAt: input.derivedAt,
      derivationVersion: input.derivationVersion,
      createdAt: input.now,
    };
    if (this.currentRow !== null) {
      this.currentRow = { ...this.currentRow, supersededAt: input.now };
    }
    this.currentRow = row;
    return row;
  }
  async current(): Promise<AgeCredentialRow | null> {
    return this.currentRow;
  }
  async findById(): Promise<AgeCredentialRow | null> {
    return this.currentRow;
  }
}

class FakeSelector implements JurisdictionPolicySelector {
  selection: JurisdictionPolicySelection | null = null;

  async select(): Promise<JurisdictionPolicySelection | null> {
    return this.selection;
  }
}

class FakeCipher implements BirthdayCipher {
  encrypted: EncryptedBirthday = {
    digest: 'd'.repeat(64),
    ciphertext: 'aes-ciphertext',
    nonce: 'nonce',
    keyId: 'dev-key',
  };
  encryptInputs: string[] = [];

  encrypt(birthDate: string): EncryptedBirthday {
    this.encryptInputs.push(birthDate);
    return this.encrypted;
  }
  decrypt(): string {
    throw new Error('not used in these tests');
  }
  activeKeyId(): string {
    return 'dev-key';
  }
}

function makeService(clockIso: string, tz: string, document: PolicyDocument) {
  const declarations = new FakeDeclarationRepository();
  const evidence = new FakeEvidenceRepository();
  const credentials = new FakeCredentialRepository();
  const selector = new FakeSelector();
  const cipher = new FakeCipher();
  selector.selection = selection({ timezone: tz, document });
  const service = new AgeCredentialService(
    { jurisdictionDeclarations: declarations, ageEvidence: evidence, ageCredentials: credentials },
    selector,
    cipher,
    fixedClock(clockIso),
  );
  return { service, declarations, evidence, credentials, selector, cipher };
}

describe('AgeCredentialService.declare — preconditions', () => {
  it('requires a current jurisdiction declaration', async () => {
    const { service } = makeService('2026-08-17T02:00:00.000Z', 'UTC', basePolicyDocument());
    await expectRejected(
      service.declare('account-1', '2000-06-15'),
      400,
      'VALIDATION_ERROR',
      'jurisdiction_required',
    );
  });

  it('fails closed while the declaration is under conflict review', async () => {
    const { service, declarations } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = {
      id: 'd0e9f8a7-6b5c-4d3e-2f1a-0b9c8d7e6f5a',
      accountId: 'account-1',
      countryCode: 'US',
      subdivisionCode: null,
      source: 'self_declared',
      reviewState: 'conflict_review_required',
      effectiveFrom: new Date('2026-08-17T02:00:00.000Z'),
      supersededAt: null,
      version: 1,
      createdAt: new Date('2026-08-17T02:00:00.000Z'),
    };
    await expectRejected(
      service.declare('account-1', '2000-06-15'),
      400,
      'VALIDATION_ERROR',
      'jurisdiction_review_required',
    );
  });

  it('requires an active approved policy for the declaration', async () => {
    const { service, declarations, selector } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = {
      id: 'd0e9f8a7-6b5c-4d3e-2f1a-0b9c8d7e6f5a',
      accountId: 'account-1',
      countryCode: 'XZ',
      subdivisionCode: null,
      source: 'self_declared',
      reviewState: 'accepted',
      effectiveFrom: new Date('2026-08-17T02:00:00.000Z'),
      supersededAt: null,
      version: 1,
      createdAt: new Date('2026-08-17T02:00:00.000Z'),
    };
    selector.selection = null;
    await expectRejected(
      service.declare('account-1', '2000-06-15'),
      400,
      'VALIDATION_ERROR',
      'no_active_jurisdiction_policy',
    );
  });
});

describe('AgeCredentialService.declare — Temporal date-only age', () => {
  it('rejects a birth date in the future in the policy timezone', async () => {
    const { service, declarations } = makeService(
      '2026-08-17T02:00:00.000Z',
      'Asia/Shanghai',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    await expectRejected(
      service.declare('account-1', '2026-08-18'),
      400,
      'VALIDATION_ERROR',
      'birth_date_in_future',
    );
  });

  it('accepts a birth date that is local today even when it is UTC tomorrow', async () => {
    const { service, declarations } = makeService(
      '2026-08-16T20:30:00.000Z',
      'Pacific/Kiritimati',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    const view = await service.declare('account-1', '2026-08-17');
    expect(view.age_band).toBe('below_minimum');
    expect(view.cohort_key).toBe('below_minimum');
  });

  it('rejects a birth date that is UTC today but still in the local future', async () => {
    const { service, declarations } = makeService(
      '2026-08-17T05:00:00.000Z',
      'Pacific/Honolulu',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    await expectRejected(
      service.declare('account-1', '2026-08-17'),
      400,
      'VALIDATION_ERROR',
      'birth_date_in_future',
    );
  });

  it('ages a Feb-29 birth on Feb 28 of non-leap years (18 on 2026-02-28, 17 on 2026-02-27)', async () => {
    for (const [day, expected] of [
      ['2026-02-27T12:00:00.000Z', 'youth'],
      ['2026-02-28T12:00:00.000Z', 'adult'],
    ] as const) {
      const { service, declarations } = makeService(day, 'UTC', basePolicyDocument());
      declarations.currentRow = acceptedDeclaration();
      const view = await service.declare('account-1', '2008-02-29');
      expect(view.age_band).toBe(expected);
      expect(view.cohort_key).toBe(expected === 'youth' ? 'youth_17' : 'adult');
    }
  });

  it('derives bands and per-year cohort keys from the policy thresholds', async () => {
    const cases: Array<{ birth: string; band: string; cohort: string }> = [
      { birth: '2015-06-15', band: 'below_minimum', cohort: 'below_minimum' },
      { birth: '2011-06-15', band: 'youth', cohort: 'youth_15' },
      { birth: '2008-06-15', band: 'adult', cohort: 'adult' },
    ];
    for (const c of cases) {
      const { service, declarations } = makeService(
        '2026-08-17T02:00:00.000Z',
        'UTC',
        basePolicyDocument(),
      );
      declarations.currentRow = acceptedDeclaration();
      const view = await service.declare('account-1', c.birth);
      expect(view.age_band).toBe(c.band);
      expect(view.cohort_key).toBe(c.cohort);
    }
  });
});

describe('AgeCredentialService.declare — issue and replace', () => {
  it('issues a self-declared credential derived under the active policy', async () => {
    const { service, declarations, evidence, credentials, cipher } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    const view = await service.declare('account-1', '2000-06-15');
    expect(view.credential_id).toMatch(UUID_V4);
    expect(view.age_band).toBe('adult');
    expect(view.cohort_key).toBe('adult');
    expect(view.assurance_level).toBe('self_declared');
    expect(view.valid_until).toBe('2027-06-15T00:00:00.000Z');
    expect(cipher.encryptInputs).toEqual(['2000-06-15']);
    expect(evidence.upsertInputs[0]?.birthdayDigest).toBe('d'.repeat(64));
    expect(evidence.upsertInputs[0]?.ciphertext).toBe('aes-ciphertext');
    const insert = credentials.insertCalls[0];
    expect(insert?.issuerType).toBe('eligibility_self_declaration');
    expect(insert?.assuranceLevel).toBe('self_declared');
    expect(insert?.jurisdictionPolicyId).toBe(POLICY_ID);
    expect(insert?.policyRevision).toBe(1);
    expect(insert?.derivationVersion).toBe(1);
    // The response must never echo the birth date.
    expect(JSON.stringify(view)).not.toContain('2000-06-15');
    expect(view).not.toHaveProperty('birth_date');
  });

  it('stores the open-ended policy end as the credential validity end', async () => {
    const { service, declarations, credentials } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    await service.declare('account-1', '2000-06-15');
    expect(credentials.insertCalls[0]?.validUntil).toEqual(new Date('2027-06-15T00:00:00.000Z'));
  });

  it('is idempotent for the same birth date — no credential churn', async () => {
    const { service, declarations, credentials, evidence } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    const first = await service.declare('account-1', '2000-06-15');
    const second = await service.declare('account-1', '2000-06-15');
    expect(second.credential_id).toBe(first.credential_id);
    expect(credentials.insertCalls).toHaveLength(1);
    expect(evidence.upsertInputs).toHaveLength(2); // the evidence no-op lives in the repository
  });

  it('issues a replacement credential when the policy revision changed', async () => {
    const { service, declarations, credentials } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    const first = await service.declare('account-1', '2000-06-15');
    const selector = (service as unknown as { selector: FakeSelector }).selector;
    selector.selection = selection({ revision: 2, document: basePolicyDocument({ revision: 2 }) });
    const view = await service.declare('account-1', '2000-06-15');
    expect(credentials.insertCalls).toHaveLength(2);
    expect(view.credential_id).not.toBe(first.credential_id);
  });

  it('caps valid_until at the policy interval end for a closed policy', async () => {
    const { service, declarations, credentials } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    (service as unknown as { selector: FakeSelector }).selector.selection = selection({
      effective_until: '2026-12-31T23:59:59Z',
    });
    const view = await service.declare('account-1', '2000-06-15');
    expect(view.valid_until).toBe('2026-12-31T23:59:59.000Z');
    expect(credentials.insertCalls[0]?.validUntil).toEqual(new Date('2026-12-31T23:59:59Z'));
  });
});

describe('AgeCredentialService.current', () => {
  it('returns null for an account without a credential', async () => {
    const { service } = makeService('2026-08-17T02:00:00.000Z', 'UTC', basePolicyDocument());
    await expect(service.current('account-1')).resolves.toBeNull();
  });

  it('returns the current credential view without the birth date', async () => {
    const { service, declarations, credentials } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    await service.declare('account-1', '2000-06-15');
    const view = await service.current('account-1');
    expect(view?.credential_id).toBe(credentials.currentRow?.id);
    expect(JSON.stringify(view)).not.toContain('2000-06-15');
  });

  it('returns null after the current credential validity window closes', async () => {
    const { service, declarations, credentials } = makeService(
      '2026-08-17T02:00:00.000Z',
      'UTC',
      basePolicyDocument(),
    );
    declarations.currentRow = acceptedDeclaration();
    await service.declare('account-1', '2000-06-15');
    credentials.currentRow!.validUntil = new Date('2026-08-17T02:00:00.000Z');
    await expect(service.current('account-1')).resolves.toBeNull();
  });
});

function acceptedDeclaration(): JurisdictionDeclarationRow {
  return {
    id: 'd0e9f8a7-6b5c-4d3e-2f1a-0b9c8d7e6f5a',
    accountId: 'account-1',
    countryCode: 'US',
    subdivisionCode: null,
    source: 'self_declared',
    reviewState: 'accepted',
    effectiveFrom: new Date('2026-08-17T02:00:00.000Z'),
    supersededAt: null,
    version: 1,
    createdAt: new Date('2026-08-17T02:00:00.000Z'),
  };
}
