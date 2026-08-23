import { describe, expect, it } from 'vitest';
import {
  OPEN_ENDED,
  ageBandSchema,
  ageDeclarationRequestSchema,
  ageDeclarationResponseSchema,
  assuranceLevelSchema,
  birthDateSchema,
  capabilityCodes,
  capabilitySchema,
  countryCodeSchema,
  decisionIdSchema,
  decisionOutputSchema,
  eligibilityStatusResponseSchema,
  idempotencyKeySchema,
  issuerTypeSchema,
  jurisdictionDeclarationRequestSchema,
  jurisdictionDeclarationResponseSchema,
  jurisdictionKeySchema,
  modeCodes,
  modeDecisionInputSchema,
  modeEvaluationRequestSchema,
  modeEvaluationResponseSchema,
  obligationCodes,
  partitionDecisionInputSchema,
  policyDocumentSchema,
  reasonCodes,
  subdivisionCodeSchema,
  type PolicyDocument,
} from '../../src/index.js';

/** Complete, valid policy document fixture (synthetic, non-PII). */
function policyDoc(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return {
    policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
    revision: 3,
    minimum_account_age: 13,
    age_of_majority: 18,
    digital_consent_age: 16,
    parental_consent_required_below: 16,
    youth_launch_state: 'launched',
    allowed_cohorts: ['youth_13', 'youth_14', 'youth_15', 'youth_16', 'youth_17', 'adult'],
    cross_cohort_contact_policy: 'same_cohort_only',
    mode_rules: {
      mode_enabled: {
        friends: true,
        activities: true,
        professional: true,
        circles: true,
        events: true,
        dating: false,
      },
      platform_minimum_age_by_mode: {
        friends: 13,
        activities: 13,
        professional: 13,
        circles: 13,
        events: 13,
        dating: 18,
      },
      mode_minimum_age: {
        friends: 0,
        activities: 0,
        professional: 0,
        circles: 0,
        events: 0,
        dating: 21,
      },
      required_age_assurance_by_mode: {
        friends: 'self_declared',
        activities: 'self_declared',
        professional: 'self_declared',
        circles: 'self_declared',
        events: 'self_declared',
        dating: 'externally_attested',
      },
    },
    ...overrides,
  };
}

const SUBJECT = {
  age_years: 17,
  age_band: 'youth' as const,
  cohort_key: 'youth_17',
  assurance_level: 'self_declared' as const,
};

describe('eligibility enums (fixed order)', () => {
  it('pins the six modes in contract order', () => {
    expect(modeCodes).toEqual([
      'friends',
      'activities',
      'professional',
      'circles',
      'events',
      'dating',
    ]);
  });

  it('pins the four age bands and two assurance levels', () => {
    expect(ageBandSchema.options).toEqual(['unknown', 'below_minimum', 'youth', 'adult']);
    expect(assuranceLevelSchema.options).toEqual(['self_declared', 'externally_attested']);
    expect(issuerTypeSchema.options).toEqual([
      'eligibility_self_declaration',
      'verification_module',
    ]);
  });

  it('pins the six partition capabilities', () => {
    expect(capabilityCodes).toEqual([
      'discover',
      'introduce',
      'direct_message',
      'circles',
      'event_visibility',
      'dating',
    ]);
  });

  it('pins the obligation set to parental_consent_required', () => {
    expect(obligationCodes).toEqual(['parental_consent_required']);
  });

  it('pins the 14 reason codes in the documented evaluation order', () => {
    expect(reasonCodes).toEqual([
      'ELIGIBILITY_INCOMPLETE',
      'NO_ACTIVE_JURISDICTION_POLICY',
      'JURISDICTION_REVIEW_REQUIRED',
      'BELOW_MINIMUM_ACCOUNT_AGE',
      'PARENTAL_CONSENT_REQUIRED',
      'YOUTH_NOT_LAUNCHED',
      'MODE_DISABLED',
      'MODE_MINIMUM_AGE_NOT_MET',
      'ADULT_THRESHOLD_NOT_MET',
      'AGE_ASSURANCE_REQUIRED',
      'CROSS_COHORT_DENIED',
      'POLICY_ENGINE_UNAVAILABLE',
      'POLICY_OUTPUT_INVALID',
      'ACCOUNT_NOT_ENABLED',
    ]);
  });

  it('rejects invented enum values everywhere', () => {
    expect(() => capabilitySchema.parse('dating_friend')).toThrow();
    expect(() => ageBandSchema.parse('teenager')).toThrow();
    expect(() => assuranceLevelSchema.parse('verified_by_lawyer')).toThrow();
  });
});

describe('OPA policy document schema', () => {
  it('accepts a complete policy document', () => {
    expect(policyDocumentSchema.parse(policyDoc())).toBeTruthy();
  });

  it('rejects a policy document missing a mode rule (no truthiness fallback)', () => {
    const partial = structuredClone(policyDoc());
    delete (partial.mode_rules.mode_enabled as Record<string, boolean>)['dating'];
    expect(() => policyDocumentSchema.parse(partial)).toThrow(/all six modes/);
  });

  it('rejects unknown keys in the policy document (strict)', () => {
    const extra = { ...policyDoc(), legal_text: 'free text opinion' } as Record<string, unknown>;
    expect(() => policyDocumentSchema.parse(extra)).toThrow();
  });

  it('rejects a non-v4 policy id', () => {
    const bad = policyDoc({ policy_id: 'policy-123' });
    expect(() => policyDocumentSchema.parse(bad)).toThrow();
  });
});

describe('OPA mode decision input', () => {
  it('accepts the canonical derived input', () => {
    expect(
      modeDecisionInputSchema.parse({
        policy: policyDoc(),
        subject: SUBJECT,
        request: { mode: 'friends', effective_at: '2026-08-16T12:00:00.000Z' },
      }),
    ).toBeTruthy();
  });

  it('rejects PII smuggled into the input (strict)', () => {
    const withPii = {
      policy: policyDoc(),
      subject: SUBJECT,
      request: { mode: 'friends', effective_at: '2026-08-16T12:00:00.000Z' },
      account_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      birthday: '1990-01-01',
      email: 'member@example.com',
      ip: '203.0.113.9',
    };
    expect(() => modeDecisionInputSchema.parse(withPii)).toThrow();
  });

  it('rejects a birthday hidden inside the subject document', () => {
    const withBirthday = {
      policy: policyDoc(),
      subject: { ...SUBJECT, birth_date: '1990-01-01' },
      request: { mode: 'friends', effective_at: '2026-08-16T12:00:00.000Z' },
    };
    expect(() => modeDecisionInputSchema.parse(withBirthday)).toThrow();
  });

  it('rejects unknown modes and non-datetime effective_at', () => {
    expect(() =>
      modeDecisionInputSchema.parse({
        policy: policyDoc(),
        subject: SUBJECT,
        request: { mode: 'swimming', effective_at: '2026-08-16T12:00:00.000Z' },
      }),
    ).toThrow();
    expect(() =>
      modeDecisionInputSchema.parse({
        policy: policyDoc(),
        subject: SUBJECT,
        request: { mode: 'friends', effective_at: '2026-08-16' },
      }),
    ).toThrow();
  });
});

describe('OPA partition decision input', () => {
  it('accepts a symmetric two-party input', () => {
    expect(
      partitionDecisionInputSchema.parse({
        actor_policy: policyDoc(),
        subject_policy: policyDoc(),
        actor: SUBJECT,
        subject: { ...SUBJECT, age_years: 24, age_band: 'adult', cohort_key: 'adult' },
        request: { capability: 'direct_message', effective_at: '2026-08-16T12:00:00.000Z' },
      }),
    ).toBeTruthy();
  });

  it('rejects actor account ids and free-text profiles', () => {
    const withPii = {
      actor_policy: policyDoc(),
      subject_policy: policyDoc(),
      actor: { ...SUBJECT, account_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c' },
      subject: SUBJECT,
      request: { capability: 'discover', effective_at: '2026-08-16T12:00:00.000Z' },
    };
    expect(() => partitionDecisionInputSchema.parse(withPii)).toThrow();
    const withProfile = {
      actor_policy: policyDoc(),
      subject_policy: policyDoc(),
      actor: SUBJECT,
      subject: { ...SUBJECT, display_name: 'A member' },
      request: { capability: 'discover', effective_at: '2026-08-16T12:00:00.000Z' },
    };
    expect(() => partitionDecisionInputSchema.parse(withProfile)).toThrow();
  });

  it('rejects unknown capabilities', () => {
    expect(() =>
      partitionDecisionInputSchema.parse({
        actor_policy: policyDoc(),
        subject_policy: policyDoc(),
        actor: SUBJECT,
        subject: SUBJECT,
        request: { capability: 'dating_app', effective_at: '2026-08-16T12:00:00.000Z' },
      }),
    ).toThrow();
  });
});

describe('OPA decision output schema (fail-closed surface)', () => {
  it('accepts allow and deny with whitelisted reasons', () => {
    expect(
      decisionOutputSchema.parse({ decision: 'allow', reason_codes: [], obligations: [] }),
    ).toBeTruthy();
    expect(
      decisionOutputSchema.parse({
        decision: 'deny',
        reason_codes: ['MODE_MINIMUM_AGE_NOT_MET'],
        obligations: [],
      }),
    ).toBeTruthy();
  });

  it('rejects unknown reason codes and obligations', () => {
    expect(() =>
      decisionOutputSchema.parse({
        decision: 'deny',
        reason_codes: ['ENGINE_DECIDED_IT_WAS_FINE'],
        obligations: [],
      }),
    ).toThrow();
    expect(() =>
      decisionOutputSchema.parse({
        decision: 'deny',
        reason_codes: [],
        obligations: ['send_the_birthday_out'],
      }),
    ).toThrow();
  });

  it('rejects unexpected output fields and invalid decisions', () => {
    expect(() =>
      decisionOutputSchema.parse({
        decision: 'deny',
        reason_codes: [],
        obligations: [],
        legal_opinion: 'it is fine',
      }),
    ).toThrow();
    expect(() =>
      decisionOutputSchema.parse({ decision: 'maybe', reason_codes: [], obligations: [] }),
    ).toThrow();
  });
});

describe('birth date schema', () => {
  it('accepts real calendar dates', () => {
    expect(birthDateSchema.parse('2008-08-16')).toBe('2008-08-16');
    expect(birthDateSchema.parse('2012-02-29')).toBe('2012-02-29');
  });

  it('rejects calendar-invalid, malformed, and out-of-range dates', () => {
    expect(() => birthDateSchema.parse('2023-02-29')).toThrow();
    expect(() => birthDateSchema.parse('2023-13-01')).toThrow();
    expect(() => birthDateSchema.parse('2023-1-01')).toThrow();
    expect(() => birthDateSchema.parse('1899-12-31')).toThrow();
    expect(() => birthDateSchema.parse('0000-01-01')).toThrow();
  });

  it('does not apply a UTC upper bound before the policy timezone is known', () => {
    expect(birthDateSchema.parse('2099-01-01')).toBe('2099-01-01');
  });
});

describe('jurisdiction DTOs', () => {
  it('accepts country and country+subdivision claims', () => {
    expect(jurisdictionDeclarationRequestSchema.parse({ country_code: 'US' })).toEqual({
      country_code: 'US',
    });
    expect(
      jurisdictionDeclarationRequestSchema.parse({
        country_code: 'US',
        subdivision_code: 'CA',
      }),
    ).toEqual({ country_code: 'US', subdivision_code: 'CA' });
  });

  it('rejects lowercase, non-alpha and oversized country codes', () => {
    expect(() => jurisdictionDeclarationRequestSchema.parse({ country_code: 'us' })).toThrow();
    expect(() => jurisdictionDeclarationRequestSchema.parse({ country_code: 'U1' })).toThrow();
    expect(() => jurisdictionDeclarationRequestSchema.parse({ country_code: 'USA' })).toThrow();
  });

  it('rejects reviewed claims over the public API', () => {
    expect(() =>
      jurisdictionDeclarationRequestSchema.parse({ country_code: 'US', source: 'reviewed' }),
    ).toThrow();
  });

  it('rejects a smuggled account_id in the request body', () => {
    expect(() =>
      jurisdictionDeclarationRequestSchema.parse({
        country_code: 'US',
        account_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      }),
    ).toThrow();
  });

  it('parses the response without free text', () => {
    expect(
      jurisdictionDeclarationResponseSchema.parse({
        declaration_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
        country_code: 'US',
        review_state: 'accepted',
        effective_from: '2026-08-16T12:00:00.000Z',
      }),
    ).toBeTruthy();
  });
});

describe('age declaration DTOs', () => {
  it('accepts a date-only birth_date and rejects extra keys', () => {
    expect(ageDeclarationRequestSchema.parse({ birth_date: '2008-08-16' })).toEqual({
      birth_date: '2008-08-16',
    });
    expect(() =>
      ageDeclarationRequestSchema.parse({
        birth_date: '2008-08-16',
        assurance_level: 'self_declared',
      }),
    ).toThrow();
  });

  it('response never echoes the birth date', () => {
    const parsed = ageDeclarationResponseSchema.parse({
      credential_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      age_band: 'youth',
      cohort_key: 'youth_17',
      assurance_level: 'self_declared',
      valid_until: '2026-12-31T23:59:59Z',
    });
    expect(JSON.stringify(parsed)).not.toContain('2008');
    expect(() =>
      ageDeclarationResponseSchema.parse({
        credential_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
        age_band: 'youth',
        cohort_key: 'youth_17',
        assurance_level: 'self_declared',
        valid_until: '2026-12-31T23:59:59Z',
        birth_date: '2008-08-16',
      }),
    ).toThrow();
  });
});

describe('status response DTO', () => {
  it('accepts all-null and fully-populated states', () => {
    expect(
      eligibilityStatusResponseSchema.parse({ jurisdiction: null, active_policy: null, age: null }),
    ).toBeTruthy();
    expect(
      eligibilityStatusResponseSchema.parse({
        jurisdiction: {
          declaration_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
          country_code: 'US',
          subdivision_code: 'CA',
          review_state: 'conflict_review_required',
          effective_from: '2026-08-16T12:00:00.000Z',
        },
        active_policy: {
          policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
          jurisdiction_key: 'US-CA',
          revision: 3,
          effective_from: '2026-08-01T00:00:00Z',
          effective_until: OPEN_ENDED,
          timezone: 'America/Los_Angeles',
        },
        age: {
          credential_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
          age_band: 'youth',
          cohort_key: 'youth_17',
          assurance_level: 'self_declared',
          valid_from: '2026-08-16T12:00:00.000Z',
          valid_until: OPEN_ENDED,
        },
      }),
    ).toBeTruthy();
  });

  it('rejects a policy with free-text legal content', () => {
    expect(() =>
      eligibilityStatusResponseSchema.parse({
        jurisdiction: null,
        active_policy: {
          policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
          jurisdiction_key: 'US',
          revision: 3,
          effective_from: '2026-08-01T00:00:00Z',
          effective_until: OPEN_ENDED,
          timezone: 'America/New_York',
          legal_text: 'per our lawyers',
        },
        age: null,
      }),
    ).toThrow();
  });
});

describe('mode evaluation DTOs', () => {
  it('accepts a minimal request and a fully-specified one', () => {
    expect(modeEvaluationRequestSchema.parse({ mode: 'friends' })).toEqual({ mode: 'friends' });
    expect(
      modeEvaluationRequestSchema.parse({
        mode: 'dating',
        effective_at: '2026-08-16T12:00:00.000Z',
        idempotency_key: 'k-8chars',
      }),
    ).toEqual({
      mode: 'dating',
      effective_at: '2026-08-16T12:00:00.000Z',
      idempotency_key: 'k-8chars',
    });
  });

  it('rejects short idempotency keys and unknown modes', () => {
    expect(() =>
      modeEvaluationRequestSchema.parse({ mode: 'dating', idempotency_key: 'short' }),
    ).toThrow();
    expect(() => modeEvaluationRequestSchema.parse({ mode: 'swimming' })).toThrow();
  });

  it('accepts a full response and rejects birthday / free text', () => {
    expect(
      modeEvaluationResponseSchema.parse({
        decision_id: '3f1c7f1e-9a2b-5c3d-8e4f-5a6b7c8d9e0f',
        scope: 'age_and_jurisdiction',
        decision: 'allow',
        mode: 'friends',
        age_band: 'youth',
        cohort_key: 'youth_17',
        assurance_level: 'self_declared',
        reason_codes: [],
        obligations: ['parental_consent_required'],
        policy: {
          policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
          revision: 3,
          policy_hash: 'a'.repeat(64),
        },
        credential: {
          credential_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
          assurance_level: 'self_declared',
        },
        evaluated_at: '2026-08-16T12:00:00.000Z',
        valid_until: OPEN_ENDED,
      }),
    ).toBeTruthy();
    expect(() =>
      modeEvaluationResponseSchema.parse({
        decision_id: '3f1c7f1e-9a2b-5c3d-8e4f-5a6b7c8d9e0f',
        scope: 'age_and_jurisdiction',
        decision: 'allow',
        mode: 'friends',
        age_band: 'youth',
        cohort_key: 'youth_17',
        assurance_level: 'self_declared',
        reason_codes: [],
        obligations: [],
        policy: {
          policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
          revision: 3,
          policy_hash: 'a'.repeat(64),
        },
        credential: {
          credential_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
          assurance_level: 'self_declared',
        },
        evaluated_at: '2026-08-16T12:00:00.000Z',
        valid_until: OPEN_ENDED,
        birthday: '2008-08-16',
      }),
    ).toThrow();
  });
});

describe('identifiers', () => {
  it('accepts UUID v4 and v5 forms respectively', () => {
    expect(jurisdictionKeySchema.parse('US')).toBe('US');
    expect(jurisdictionKeySchema.parse('US-CA')).toBe('US-CA');
    expect(() => jurisdictionKeySchema.parse('us-ca')).toThrow();
    expect(() => jurisdictionKeySchema.parse('USA')).toThrow();
    expect(countryCodeSchema.parse('JP')).toBe('JP');
    expect(subdivisionCodeSchema.parse('07')).toBe('07');
    expect(decisionIdSchema.parse('3f1c7f1e-9a2b-5c3d-8e4f-5a6b7c8d9e0f')).toBeTruthy();
    expect(() => decisionIdSchema.parse('3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f')).toThrow();
    expect(idempotencyKeySchema.parse('k-12345678')).toBeTruthy();
  });
});
