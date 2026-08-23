import { describe, expect, it } from 'vitest';
import type { ModeCode, PolicyDocument } from '@wai/contracts';
import {
  DATING_HARD_FLOOR,
  deriveAgeBand,
  deriveCohortKey,
  effectiveMinimumAge,
} from './policy.js';

function basePolicy(): PolicyDocument {
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
  };
}

const ALL_MODES: readonly ModeCode[] = [
  'friends',
  'activities',
  'professional',
  'circles',
  'events',
  'dating',
];

describe('effectiveMinimumAge truth matrix', () => {
  it('non-dating modes take max(minimum_account_age, platform, mode)', () => {
    const policy = basePolicy();
    for (const mode of ['friends', 'activities', 'professional', 'circles', 'events'] as const) {
      expect(effectiveMinimumAge(policy, mode)).toBe(13);
    }
  });

  it('dating always adds the fixed 18 floor and the age of majority', () => {
    expect(effectiveMinimumAge(basePolicy(), 'dating')).toBe(21); // max(13, 18, 21, 18, 18)
  });

  it('dating with a low mode minimum still never drops below 18', () => {
    const policy = basePolicy();
    policy.mode_rules.mode_minimum_age.dating = 16;
    expect(effectiveMinimumAge(policy, 'dating')).toBe(18);
  });

  it('dating with an age of majority above 18 honors the majority', () => {
    const policy = basePolicy();
    policy.age_of_majority = 21;
    policy.mode_rules.mode_minimum_age.dating = 16;
    expect(effectiveMinimumAge(policy, 'dating')).toBe(21);
  });

  it('a platform minimum above the majority governs the mode', () => {
    const policy = basePolicy();
    policy.mode_rules.platform_minimum_age_by_mode.events = 21;
    expect(effectiveMinimumAge(policy, 'events')).toBe(21);
    expect(effectiveMinimumAge(policy, 'dating')).toBe(21);
  });

  it('the dating floor constant is 18 and never configurable here', () => {
    expect(DATING_HARD_FLOOR).toBe(18);
    const policy = basePolicy();
    policy.minimum_account_age = 5;
    expect(effectiveMinimumAge(policy, 'dating')).toBe(21);
  });

  it('fails closed (throws) on a missing mode rule instead of relaxing', () => {
    const policy = basePolicy();
    delete policy.mode_rules.mode_minimum_age['dating'];
    expect(() => effectiveMinimumAge(policy, 'dating')).toThrow(/missing mode_minimum_age/);
  });
});

describe('deriveAgeBand / deriveCohortKey truth matrix (min 13, majority 18)', () => {
  it('maps exact thresholds: 12→below, 13→youth, 17→youth, 18→adult', () => {
    expect(deriveAgeBand(12, 13, 18)).toBe('below_minimum');
    expect(deriveAgeBand(13, 13, 18)).toBe('youth');
    expect(deriveAgeBand(17, 13, 18)).toBe('youth');
    expect(deriveAgeBand(18, 13, 18)).toBe('adult');
  });

  it('derives per-year cohort keys', () => {
    expect(deriveCohortKey(12, 13, 18)).toBe('below_minimum');
    expect(deriveCohortKey(13, 13, 18)).toBe('youth_13');
    expect(deriveCohortKey(17, 13, 18)).toBe('youth_17');
    expect(deriveCohortKey(18, 13, 18)).toBe('adult');
    expect(deriveCohortKey(99, 13, 18)).toBe('adult');
  });

  it('a higher age of majority extends the youth band', () => {
    expect(deriveAgeBand(18, 13, 21)).toBe('youth');
    expect(deriveAgeBand(20, 13, 21)).toBe('youth');
    expect(deriveAgeBand(21, 13, 21)).toBe('adult');
    expect(deriveCohortKey(20, 13, 21)).toBe('youth_20');
  });

  it('cohort derivation is deterministic for the same inputs', () => {
    expect(deriveCohortKey(17, 13, 18)).toBe(deriveCohortKey(17, 13, 18));
    for (const mode of ALL_MODES) {
      expect(Number.isInteger(effectiveMinimumAge(basePolicy(), mode))).toBe(true);
    }
  });
});
