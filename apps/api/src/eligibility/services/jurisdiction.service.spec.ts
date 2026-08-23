import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  EligibilityConflictError,
  type AgeCredentialRepository,
  type AgeCredentialRow,
  type JurisdictionDeclarationRepository,
  type JurisdictionDeclarationRow,
  type UpsertJurisdictionDeclarationInput,
} from '@wai/db';
import {
  OPEN_ENDED,
  type JurisdictionPolicySelection,
  type JurisdictionPolicySelector,
} from '@wai/contracts';
import type { ElgClock } from '../infra/elg-clock.js';
import { JurisdictionService } from './jurisdiction.service.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW = new Date('2026-08-17T02:00:00.000Z');

function fixedClock(): ElgClock {
  return { now: () => NOW };
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

class FakeDeclarationRepository implements JurisdictionDeclarationRepository {
  currentRow: JurisdictionDeclarationRow | null = null;
  conflict = false;
  upsertInputs: UpsertJurisdictionDeclarationInput[] = [];

  async upsertCurrent(
    input: UpsertJurisdictionDeclarationInput,
  ): Promise<JurisdictionDeclarationRow> {
    this.upsertInputs.push(input);
    if (this.conflict) {
      throw new EligibilityConflictError('concurrent jurisdiction declaration update');
    }
    if (
      this.currentRow !== null &&
      this.currentRow.countryCode === input.countryCode &&
      this.currentRow.subdivisionCode === input.subdivisionCode
    ) {
      return this.currentRow;
    }
    const row: JurisdictionDeclarationRow = {
      id: input.id,
      accountId: input.accountId,
      countryCode: input.countryCode,
      subdivisionCode: input.subdivisionCode,
      source: 'self_declared',
      reviewState: 'accepted',
      effectiveFrom: input.now,
      supersededAt: null,
      version: this.currentRow === null ? 1 : this.currentRow.version + 1,
      createdAt: input.now,
    };
    this.currentRow = row;
    return row;
  }

  async current(): Promise<JurisdictionDeclarationRow | null> {
    return this.currentRow;
  }
}

class FakeCredentialRepository implements AgeCredentialRepository {
  currentRow: AgeCredentialRow | null = null;

  async insertCurrent(_input: never): Promise<AgeCredentialRow> {
    throw new Error('not used in these tests');
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
  calls: Array<{ accountId: string; effectiveAt: string }> = [];

  async select(
    accountId: string,
    effectiveAt: string,
  ): Promise<JurisdictionPolicySelection | null> {
    this.calls.push({ accountId, effectiveAt });
    return this.selection;
  }
}

const SELECTION: JurisdictionPolicySelection = {
  policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
  jurisdiction_key: 'US-CA',
  revision: 2,
  timezone: 'America/Los_Angeles',
  effective_from: '2025-01-01T00:00:00Z',
  effective_until: OPEN_ENDED,
  content_hash: 'c'.repeat(64),
  document: undefined as never,
};

function credentialRow(overrides: Partial<AgeCredentialRow> = {}): AgeCredentialRow {
  return {
    id: 'f8e0d9c8-7b6a-5f4e-3d2c-1b0a9f8e7d6c',
    accountId: 'account-1',
    ageBand: 'adult',
    cohortKey: 'adult',
    assuranceLevel: 'self_declared',
    issuerType: 'eligibility_self_declaration',
    sourceEvidenceId: 'e7d0c9b8-6a5f-4e3d-2c1b-0a9f8e7d6c5b',
    jurisdictionPolicyId: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
    jurisdictionKey: 'US-CA',
    policyRevision: 2,
    validFrom: new Date('2026-08-17T02:00:00.000Z'),
    validUntil: new Date('9999-12-31T23:59:59.000Z'),
    supersededAt: null,
    derivedAt: new Date('2026-08-17T02:00:00.000Z'),
    derivationVersion: 1,
    createdAt: new Date('2026-08-17T02:00:00.000Z'),
    ...overrides,
  };
}

function makeService(): {
  service: JurisdictionService;
  declarations: FakeDeclarationRepository;
  credentials: FakeCredentialRepository;
  selector: FakeSelector;
} {
  const declarations = new FakeDeclarationRepository();
  const credentials = new FakeCredentialRepository();
  const selector = new FakeSelector();
  const service = new JurisdictionService(
    { jurisdictionDeclarations: declarations, ageCredentials: credentials },
    selector,
    fixedClock(),
  );
  return { service, declarations, credentials, selector };
}

describe('JurisdictionService.declare', () => {
  it('inserts a new declaration and returns the session-bound response', async () => {
    const { service, declarations } = makeService();
    const result = await service.declare('account-1', 'US', 'CA');
    expect(result.declaration_id).toMatch(UUID_V4);
    expect(result.country_code).toBe('US');
    expect(result.subdivision_code).toBe('CA');
    expect(result.review_state).toBe('accepted');
    expect(result.effective_from).toBe(NOW.toISOString());
    expect(declarations.upsertInputs[0]?.accountId).toBe('account-1');
    expect(declarations.upsertInputs[0]?.now).toEqual(NOW);
  });

  it('is idempotent for identical content — the repository no-op returns the current row', async () => {
    const { service } = makeService();
    const first = await service.declare('account-1', 'US', null);
    const second = await service.declare('account-1', 'US', null);
    expect(second.declaration_id).toBe(first.declaration_id);
    expect(second.effective_from).toBe(first.effective_from);
  });

  it('omits subdivision_code from the response when the declaration has none', async () => {
    const { service } = makeService();
    const result = await service.declare('account-1', 'US', null);
    expect(result).not.toHaveProperty('subdivision_code');
  });

  it('maps a concurrent upsert race to 409 VALIDATION_ERROR with the stable detail', async () => {
    const { service, declarations } = makeService();
    declarations.conflict = true;
    await expectRejected(
      service.declare('account-1', 'US', null),
      409,
      'VALIDATION_ERROR',
      'concurrent_declaration_update',
    );
  });
});

describe('JurisdictionService.status', () => {
  it('returns all-null for an account with nothing declared', async () => {
    const { service } = makeService();
    await expect(service.status('account-1')).resolves.toEqual({
      jurisdiction: null,
      active_policy: null,
      age: null,
    });
  });

  it('assembles declaration, active policy and credential into the status response', async () => {
    const { service, declarations, credentials, selector } = makeService();
    await service.declare('account-1', 'US', null);
    declarations.currentRow = {
      ...declarations.currentRow!,
      subdivisionCode: 'CA',
    };
    selector.selection = SELECTION;
    credentials.currentRow = credentialRow();
    const status = await service.status('account-1');
    expect(status.jurisdiction).toEqual({
      declaration_id: expect.any(String),
      country_code: 'US',
      subdivision_code: 'CA',
      review_state: 'accepted',
      effective_from: NOW.toISOString(),
    });
    expect(status.active_policy).toEqual({
      policy_id: SELECTION.policy_id,
      jurisdiction_key: 'US-CA',
      revision: 2,
      effective_from: '2025-01-01T00:00:00Z',
      effective_until: OPEN_ENDED,
      timezone: 'America/Los_Angeles',
    });
    expect(status.age).toEqual({
      credential_id: 'f8e0d9c8-7b6a-5f4e-3d2c-1b0a9f8e7d6c',
      age_band: 'adult',
      cohort_key: 'adult',
      assurance_level: 'self_declared',
      valid_from: '2026-08-17T02:00:00.000Z',
      valid_until: '9999-12-31T23:59:59.000Z',
    });
    expect(selector.calls[0]?.accountId).toBe('account-1');
  });

  it('leaves active_policy null when no policy is active for the declaration', async () => {
    const { service } = makeService();
    await service.declare('account-1', 'XZ', null);
    const status = await service.status('account-1');
    expect(status.active_policy).toBeNull();
    expect(status.jurisdiction?.country_code).toBe('XZ');
  });

  it('hides an expired or jurisdiction-mismatched credential until it is reissued', async () => {
    const { service, credentials, selector } = makeService();
    selector.selection = SELECTION;
    credentials.currentRow = credentialRow({ jurisdictionKey: 'US-NY' });
    await expect(service.status('account-1')).resolves.toMatchObject({ age: null });

    credentials.currentRow = credentialRow({
      jurisdictionKey: 'US-CA',
      validUntil: new Date('2026-08-17T01:59:59.999Z'),
    });
    await expect(service.status('account-1')).resolves.toMatchObject({ age: null });
  });

  it('serializes a closed policy interval to its ISO end', async () => {
    const { service, selector } = makeService();
    selector.selection = {
      ...SELECTION,
      jurisdiction_key: 'DE',
      effective_until: '2026-12-31T23:59:59Z',
    };
    const status = await service.status('account-1');
    expect(status.active_policy?.effective_until).toBe('2026-12-31T23:59:59Z');
  });
});
