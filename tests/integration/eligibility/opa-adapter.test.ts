import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModeDecisionInput, PartitionDecisionInput, PolicyDocument } from '@wai/contracts';
import { OpaModeDecisionAdapter, OpaPartitionDecisionAdapter } from '@wai/authz';
import { startOpaTestContainer, type StartedOpa } from '@wai/testkit';

/**
 * CP3 evidence against the REAL engine: the pinned OPA container (same image
 * as compose.yaml), loaded with the committed Rego policies, served through
 * the TypeScript fail-closed adapters. These are the exact input documents the
 * application services will build in CP4/CP5 — no fakes on either side.
 */

// Injected by vitest.config.ts; resolves to packages/authz/policies.
declare const WAI_POLICIES_DIR: string;

function basePolicy(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return {
    policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
    revision: 3,
    minimum_account_age: 13,
    age_of_majority: 18,
    digital_consent_age: 16,
    parental_consent_required_below: 16,
    youth_launch_state: 'launched',
    allowed_cohorts: ['youth_13', 'youth_14', 'youth_15', 'youth_16', 'youth_17'],
    cross_cohort_contact_policy: 'same_cohort_only',
    mode_rules: {
      mode_enabled: {
        friends: true,
        activities: true,
        professional: true,
        circles: true,
        events: true,
        dating: true,
      },
      platform_minimum_age_by_mode: {
        friends: 0,
        activities: 0,
        professional: 0,
        circles: 0,
        events: 0,
        dating: 18,
      },
      mode_minimum_age: {
        friends: 0,
        activities: 0,
        professional: 0,
        circles: 0,
        events: 0,
        dating: 0,
      },
      required_age_assurance_by_mode: {
        friends: 'self_declared',
        activities: 'self_declared',
        professional: 'self_declared',
        circles: 'self_declared',
        events: 'self_declared',
        dating: 'self_declared',
      },
    },
    ...overrides,
  };
}

function modeInput(overrides: Partial<ModeDecisionInput> = {}): ModeDecisionInput {
  return {
    policy: basePolicy(),
    subject: {
      age_years: 25,
      age_band: 'adult',
      cohort_key: 'adult_25',
      assurance_level: 'self_declared',
    },
    request: { mode: 'friends', effective_at: '2026-08-17T10:00:00+08:00' },
    ...overrides,
  };
}

function partitionInput(overrides: Partial<PartitionDecisionInput> = {}): PartitionDecisionInput {
  return {
    actor_policy: basePolicy(),
    subject_policy: basePolicy(),
    actor: {
      age_years: 25,
      age_band: 'adult',
      cohort_key: 'adult_25',
      assurance_level: 'self_declared',
    },
    subject: {
      age_years: 25,
      age_band: 'adult',
      cohort_key: 'adult_25',
      assurance_level: 'self_declared',
    },
    request: { capability: 'discover', effective_at: '2026-08-17T10:00:00+08:00' },
    ...overrides,
  };
}

let started: StartedOpa;

beforeAll(async () => {
  started = await startOpaTestContainer(WAI_POLICIES_DIR);
}, 180_000);

afterAll(async () => {
  await started.stop();
});

describe('real OPA mode_decision', () => {
  let adapter: OpaModeDecisionAdapter;

  beforeAll(() => {
    adapter = new OpaModeDecisionAdapter(started.baseUrl, 5000);
  });

  it('allows an adult on a launched mode', async () => {
    await expect(adapter.decide(modeInput())).resolves.toEqual({
      decision: 'allow',
      reason_codes: [],
      obligations: [],
    });
  });

  it('denies a below-minimum subject with the fixed ordered codes', async () => {
    await expect(
      adapter.decide(
        modeInput({
          subject: {
            age_years: 12,
            age_band: 'below_minimum',
            cohort_key: 'below_minimum_12',
            assurance_level: 'self_declared',
          },
        }),
      ),
    ).resolves.toEqual({
      decision: 'deny',
      reason_codes: [
        'BELOW_MINIMUM_ACCOUNT_AGE',
        'PARENTAL_CONSENT_REQUIRED',
        'MODE_MINIMUM_AGE_NOT_MET',
      ],
      obligations: ['parental_consent_required'],
    });
  });

  it('denies dating for a 17-year-old with ADULT_THRESHOLD_NOT_MET', async () => {
    await expect(
      adapter.decide(
        modeInput({
          subject: {
            age_years: 17,
            age_band: 'youth',
            cohort_key: 'youth_17',
            assurance_level: 'self_declared',
          },
          request: { mode: 'dating', effective_at: '2026-08-17T10:00:00+08:00' },
        }),
      ),
    ).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['ADULT_THRESHOLD_NOT_MET'],
      obligations: [],
    });
  });

  it('denies a mode that is explicitly disabled', async () => {
    const policy = basePolicy({
      mode_rules: {
        ...basePolicy().mode_rules,
        mode_enabled: {
          friends: false,
          activities: true,
          professional: true,
          circles: true,
          events: true,
          dating: true,
        },
      },
    });
    await expect(
      adapter.decide(
        modeInput({
          policy,
          subject: {
            age_years: 25,
            age_band: 'adult',
            cohort_key: 'adult_25',
            assurance_level: 'self_declared',
          },
        }),
      ),
    ).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['MODE_DISABLED'],
      obligations: [],
    });
  });
});

describe('real OPA partition_decision', () => {
  let adapter: OpaPartitionDecisionAdapter;

  beforeAll(() => {
    adapter = new OpaPartitionDecisionAdapter(started.baseUrl, 5000);
  });

  it('allows adult-adult contact on every capability', async () => {
    for (const capability of [
      'discover',
      'introduce',
      'direct_message',
      'event_visibility',
      'dating',
    ] as const) {
      await expect(
        adapter.decide(
          partitionInput({
            request: { capability, effective_at: '2026-08-17T10:00:00+08:00' },
          }),
        ),
      ).resolves.toEqual({ decision: 'allow', reason_codes: [], obligations: [] });
    }
  });

  it('denies youth-youth contact across cohorts under same_cohort_only', async () => {
    const youth = (age: number, cohort: string) =>
      ({
        age_years: age,
        age_band: 'youth',
        cohort_key: cohort,
        assurance_level: 'self_declared',
      }) as const;
    await expect(
      adapter.decide(
        partitionInput({
          actor: youth(16, 'youth_16'),
          subject: youth(17, 'youth_17'),
          request: { capability: 'discover', effective_at: '2026-08-17T10:00:00+08:00' },
        }),
      ),
    ).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['CROSS_COHORT_DENIED'],
      obligations: [],
    });
  });

  it('allows same-cohort youth contact under all_youth policy', async () => {
    const policy = basePolicy({ cross_cohort_contact_policy: 'all_youth' });
    const youth = {
      age_years: 16,
      age_band: 'youth',
      cohort_key: 'youth_16',
      assurance_level: 'self_declared',
    } as const;
    await expect(
      adapter.decide(
        partitionInput({
          actor_policy: policy,
          subject_policy: policy,
          actor: youth,
          subject: youth,
          request: { capability: 'direct_message', effective_at: '2026-08-17T10:00:00+08:00' },
        }),
      ),
    ).resolves.toEqual({ decision: 'allow', reason_codes: [], obligations: [] });
  });
});
