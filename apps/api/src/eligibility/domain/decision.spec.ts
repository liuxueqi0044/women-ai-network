import { describe, expect, it } from 'vitest';
import { decisionIdSchema, ELIGIBILITY_ENGINE_VERSION, reasonCodes } from '@wai/contracts';
import {
  decisionReasonOrder,
  decisionValidUntil,
  deriveDecisionId,
  derivePartitionDecisionId,
  ENGINE_VERSION,
  primaryReason,
} from './decision.js';

const FIELDS = {
  account_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
  mode: 'dating',
  effective_at: '2026-08-16T12:00:00.000Z',
  policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
  credential_id: 'c1d2e3f4-6b2a-4e12-9a1c-2d3e4f5a6b7c',
  input_hash: 'a'.repeat(64),
  idempotency_key: 'k-12345678',
};

describe('decisionReasonOrder', () => {
  it('matches the pinned 14-code contract order exactly', () => {
    expect(decisionReasonOrder).toEqual(reasonCodes);
    expect(decisionReasonOrder).toHaveLength(14);
  });
});

describe('primaryReason', () => {
  it('picks the first applicable code in the fixed order', () => {
    expect(primaryReason(['MODE_MINIMUM_AGE_NOT_MET'])).toBe('MODE_MINIMUM_AGE_NOT_MET');
    expect(primaryReason(['YOUTH_NOT_LAUNCHED', 'MODE_DISABLED'])).toBe('YOUTH_NOT_LAUNCHED');
    expect(primaryReason(['MODE_DISABLED', 'BELOW_MINIMUM_ACCOUNT_AGE'])).toBe(
      'BELOW_MINIMUM_ACCOUNT_AGE',
    );
    expect(primaryReason(['POLICY_ENGINE_UNAVAILABLE', 'AGE_ASSURANCE_REQUIRED'])).toBe(
      'AGE_ASSURANCE_REQUIRED',
    );
  });

  it('throws on an empty or unknown reason list (never guess)', () => {
    expect(() => primaryReason([])).toThrow(/without any known reason/);
    expect(() => primaryReason(['NOT_A_REAL_CODE' as never])).toThrow();
  });
});

describe('ENGINE_VERSION', () => {
  it('mirrors the shared contract version', () => {
    expect(ENGINE_VERSION).toBe(ELIGIBILITY_ENGINE_VERSION);
    expect(ENGINE_VERSION).toBe(1);
  });
});

describe('decisionValidUntil (earlier of credential and policy windows)', () => {
  const day = (iso: string): Date => new Date(iso);

  it('is open-ended only when both windows are open-ended', () => {
    expect(decisionValidUntil(Infinity, Infinity)).toBe(Infinity);
    expect(decisionValidUntil(new Date('2026-12-31T00:00:00.000Z'), Infinity)).toEqual(
      new Date('2026-12-31T00:00:00.000Z'),
    );
    expect(decisionValidUntil(Infinity, new Date('2026-12-31T00:00:00.000Z'))).toEqual(
      new Date('2026-12-31T00:00:00.000Z'),
    );
  });

  it('takes the earlier of two bounded windows', () => {
    expect(
      decisionValidUntil(day('2026-12-31T00:00:00.000Z'), day('2027-06-30T00:00:00.000Z')),
    ).toEqual(day('2026-12-31T00:00:00.000Z'));
    expect(
      decisionValidUntil(day('2027-06-30T00:00:00.000Z'), day('2026-12-31T00:00:00.000Z')),
    ).toEqual(day('2026-12-31T00:00:00.000Z'));
  });

  it('treats equal instants as a single horizon', () => {
    expect(
      decisionValidUntil(day('2026-12-31T00:00:00.000Z'), day('2026-12-31T00:00:00.000Z')),
    ).toEqual(day('2026-12-31T00:00:00.000Z'));
  });
});

describe('deriveDecisionId (deterministic idempotency key)', () => {
  it('returns a valid UUID v5', () => {
    const id = deriveDecisionId(FIELDS);
    expect(decisionIdSchema.safeParse(id).success).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    expect(deriveDecisionId(FIELDS)).toBe(deriveDecisionId(FIELDS));
  });

  it('changes when any single input field changes', () => {
    const baseline = deriveDecisionId(FIELDS);
    const cases: Array<[keyof typeof FIELDS, string]> = [
      ['mode', 'friends'],
      ['effective_at', '2026-08-16T13:00:00.000Z'],
      ['policy_id', '4f2c8f2e-9a3b-4c4d-8f4e-5a6b7c8d9e0f'],
      ['credential_id', 'd2e3f4a5-6b2a-4e12-9a1c-2d3e4f5a6b7c'],
      ['input_hash', 'b'.repeat(64)],
      ['idempotency_key', 'k-87654321'],
      ['account_id', 'e5f6a7b8-6b2a-4e12-9a1c-2d3e4f5a6b7c'],
    ];
    for (const [field, replacement] of cases) {
      expect(deriveDecisionId({ ...FIELDS, [field]: replacement })).not.toBe(baseline);
    }
  });
});

const PARTITION_FIELDS = {
  actor_account_id: 'b4e9b4e9-6b2a-4e12-9a1c-2d3e4f5a6b7c',
  subject_account_id: 'e5f6a7b8-6b2a-4e12-9a1c-2d3e4f5a6b7c',
  capability: 'dating',
  effective_at: '2026-08-16T12:00:00.000Z',
  actor_policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
  subject_policy_id: '4f2c8f2e-9a3b-4c4d-8f4e-5a6b7c8d9e0f',
  actor_credential_id: 'c1d2e3f4-6b2a-4e12-9a1c-2d3e4f5a6b7c',
  subject_credential_id: 'd2e3f4a5-6b2a-4e12-9a1c-2d3e4f5a6b7c',
  input_hash: 'a'.repeat(64),
};

describe('derivePartitionDecisionId (two-party deterministic key)', () => {
  it('returns a valid UUID v5', () => {
    const id = derivePartitionDecisionId(PARTITION_FIELDS);
    expect(decisionIdSchema.safeParse(id).success).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    expect(derivePartitionDecisionId(PARTITION_FIELDS)).toBe(
      derivePartitionDecisionId(PARTITION_FIELDS),
    );
  });

  it('changes when any single input field changes', () => {
    const baseline = derivePartitionDecisionId(PARTITION_FIELDS);
    const cases: Array<[keyof typeof PARTITION_FIELDS, string]> = [
      ['capability', 'discover'],
      ['effective_at', '2026-08-16T13:00:00.000Z'],
      ['actor_policy_id', '5f3d9f3e-9a2b-4c3d-8e4f-5a6b7c8d9e0f'],
      ['subject_policy_id', '6f4eaf4f-9a3b-4c4d-8f4e-5a6b7c8d9e0f'],
      ['actor_credential_id', 'e5f6a7b8-6b2a-4e12-9a1c-2d3e4f5a6b7c'],
      ['subject_credential_id', 'f6a7b8c9-6b2a-4e12-9a1c-2d3e4f5a6b7c'],
      ['input_hash', 'b'.repeat(64)],
      ['actor_account_id', 'a1b2c3d4-6b2a-4e12-9a1c-2d3e4f5a6b7c'],
      ['subject_account_id', 'c3d4e5f6-6b2a-4e12-9a1c-2d3e4f5a6b7c'],
    ];
    for (const [field, replacement] of cases) {
      expect(derivePartitionDecisionId({ ...PARTITION_FIELDS, [field]: replacement })).not.toBe(
        baseline,
      );
    }
  });

  it('differs from the single-subject id even for the same effective instant', () => {
    expect(derivePartitionDecisionId(PARTITION_FIELDS)).not.toBe(
      deriveDecisionId({
        account_id: PARTITION_FIELDS.actor_account_id,
        mode: 'dating',
        effective_at: PARTITION_FIELDS.effective_at,
        policy_id: PARTITION_FIELDS.actor_policy_id,
        credential_id: PARTITION_FIELDS.actor_credential_id,
        input_hash: PARTITION_FIELDS.input_hash,
        idempotency_key: '',
      }),
    );
  });
});
