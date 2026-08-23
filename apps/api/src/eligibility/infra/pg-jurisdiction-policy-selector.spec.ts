import { describe, expect, it } from 'vitest';
import type {
  JurisdictionDeclarationRepository,
  JurisdictionDeclarationRow,
  JurisdictionPolicyRepository,
  JurisdictionPolicyRow,
} from '@wai/db';
import { OPEN_ENDED, type PolicyDocument } from '@wai/contracts';
import { canonicalJsonHash } from '@wai/db';
import { PgJurisdictionPolicySelector } from './pg-jurisdiction-policy-selector.js';

const POLICY_ID = '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f';

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

function policyRow(overrides: Partial<JurisdictionPolicyRow> = {}): JurisdictionPolicyRow {
  const content = (overrides.content as PolicyDocument | undefined) ?? basePolicyDocument();
  const ruleContent = {
    minimum_account_age: content.minimum_account_age,
    age_of_majority: content.age_of_majority,
    digital_consent_age: content.digital_consent_age,
    parental_consent_required_below: content.parental_consent_required_below,
    youth_launch_state: content.youth_launch_state,
    allowed_cohorts: content.allowed_cohorts,
    cross_cohort_contact_policy: content.cross_cohort_contact_policy,
    mode_rules: content.mode_rules,
  };
  return {
    id: POLICY_ID,
    jurisdictionKey: 'US',
    revision: 1,
    status: 'approved',
    content,
    contentHash: canonicalJsonHash(content),
    ruleHash: canonicalJsonHash(ruleContent),
    locationPrecisionPolicy: 'country_and_subdivision',
    profilingPolicy: 'derived_facts_only',
    retentionPolicy: 'credential_until_superseded',
    legalBasisRefs: ['synthetic:test'],
    reviewedBy: 'test-reviewer',
    reviewedAt: new Date('2026-01-01T00:00:00.000Z'),
    timezone: 'UTC',
    effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    effectiveUntil: Infinity,
    isSynthetic: false,
    retiredAt: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function declaration(
  overrides: Partial<JurisdictionDeclarationRow> = {},
): JurisdictionDeclarationRow {
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
    ...overrides,
  };
}

class FakeDeclarationRepository implements Pick<JurisdictionDeclarationRepository, 'current'> {
  currentRow: JurisdictionDeclarationRow | null = null;

  async current(): Promise<JurisdictionDeclarationRow | null> {
    return this.currentRow;
  }
}

class FakePolicyRepository implements Pick<JurisdictionPolicyRepository, 'findActive'> {
  rows = new Map<string, JurisdictionPolicyRow>();
  lookups: string[] = [];

  async findActive(jurisdictionKey: string, at: Date): Promise<JurisdictionPolicyRow | null> {
    this.lookups.push(jurisdictionKey);
    const row = this.rows.get(jurisdictionKey);
    if (row === undefined) {
      return null;
    }
    if (at < row.effectiveFrom) {
      return null;
    }
    if (row.effectiveUntil !== Infinity && at >= row.effectiveUntil) {
      return null;
    }
    return row;
  }
}

function makeSelector() {
  const declarations = new FakeDeclarationRepository();
  const policies = new FakePolicyRepository();
  const selector = new PgJurisdictionPolicySelector(declarations, policies);
  return { declarations, policies, selector };
}

const EFFECTIVE_AT = '2026-08-17T02:00:00.000Z';

describe('PgJurisdictionPolicySelector.select', () => {
  it('returns null for an account without a jurisdiction declaration', async () => {
    const { selector } = makeSelector();
    await expect(selector.select('account-1', EFFECTIVE_AT)).resolves.toBeNull();
  });

  it('selects the country policy for a declaration without a subdivision', async () => {
    const { declarations, policies, selector } = makeSelector();
    declarations.currentRow = declaration();
    policies.rows.set('US', policyRow());
    const selection = await selector.select('account-1', EFFECTIVE_AT);
    expect(selection?.policy_id).toBe(POLICY_ID);
    expect(selection?.jurisdiction_key).toBe('US');
    expect(selection?.content_hash).toBe(canonicalJsonHash(basePolicyDocument()));
    expect(policies.lookups).toEqual(['US']);
  });

  it('prefers the subdivision policy and falls back to the country policy', async () => {
    const { declarations, policies, selector } = makeSelector();
    declarations.currentRow = declaration({ subdivisionCode: 'CA' });
    policies.rows.set('US', policyRow());
    policies.rows.set(
      'US-CA',
      policyRow({
        id: '4f2c8f2e-9a3b-4c4d-8f4e-5a6b7c8d9e0f',
        jurisdictionKey: 'US-CA',
        revision: 2,
        content: basePolicyDocument({
          policy_id: '4f2c8f2e-9a3b-4c4d-8f4e-5a6b7c8d9e0f',
          revision: 2,
        }),
        timezone: 'America/Los_Angeles',
      }),
    );
    const selection = await selector.select('account-1', EFFECTIVE_AT);
    expect(selection?.policy_id).toBe('4f2c8f2e-9a3b-4c4d-8f4e-5a6b7c8d9e0f');
    expect(selection?.jurisdiction_key).toBe('US-CA');
    expect(selection?.revision).toBe(2);
    expect(selection?.timezone).toBe('America/Los_Angeles');
    expect(policies.lookups).toEqual(['US-CA']);
  });

  it('falls back to the country policy when the subdivision has no active policy', async () => {
    const { declarations, policies, selector } = makeSelector();
    declarations.currentRow = declaration({ subdivisionCode: 'XX' });
    policies.rows.set('US', policyRow());
    const selection = await selector.select('account-1', EFFECTIVE_AT);
    expect(selection?.jurisdiction_key).toBe('US');
    expect(policies.lookups).toEqual(['US-XX', 'US']);
  });

  it('returns null when no policy is active for either key', async () => {
    const { declarations, selector } = makeSelector();
    declarations.currentRow = declaration({ countryCode: 'XZ' });
    await expect(selector.select('account-1', EFFECTIVE_AT)).resolves.toBeNull();
  });

  it('does not select a policy outside its effective interval', async () => {
    const { declarations, policies, selector } = makeSelector();
    declarations.currentRow = declaration();
    policies.rows.set(
      'US',
      policyRow({
        effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
        effectiveUntil: new Date('2028-01-01T00:00:00.000Z'),
      }),
    );
    await expect(selector.select('account-1', EFFECTIVE_AT)).resolves.toBeNull();
  });

  it('serializes the open-ended interval to the OPEN_ENDED sentinel', async () => {
    const { declarations, policies, selector } = makeSelector();
    declarations.currentRow = declaration();
    policies.rows.set('US', policyRow({ effectiveUntil: Infinity }));
    const selection = await selector.select('account-1', EFFECTIVE_AT);
    expect(selection?.effective_until).toBe(OPEN_ENDED);
  });

  it('fails closed when stored content is not a valid policy document', async () => {
    const { declarations, policies, selector } = makeSelector();
    declarations.currentRow = declaration();
    policies.rows.set('US', policyRow({ content: { policy_id: POLICY_ID, revision: 1 } }));
    await expect(selector.select('account-1', EFFECTIVE_AT)).rejects.toThrow(
      /policy .+ content failed validation/,
    );
  });
});
