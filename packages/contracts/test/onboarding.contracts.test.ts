import { describe, expect, it } from 'vitest';
import {
  onboardingAnswerSchema,
  onboardingConfirmSchema,
  onboardingModeSchema,
  onboardingPreferenceSchema,
  onboardingStrengthSchema,
  providerConsentSchema,
} from '../src/onboarding/index.js';

describe('ONB-01 strict contracts', () => {
  it('uses closed strengths and rejects inferred identity/age facts', () => {
    expect(onboardingStrengthSchema.safeParse('hard_requirement').success).toBe(true);
    expect(onboardingStrengthSchema.safeParse('maybe').success).toBe(false);
    expect(
      onboardingPreferenceSchema.safeParse({
        mode: 'friends',
        criterion: 'gender',
        strength: 'hard_requirement',
        value: 'woman',
        inferred: true,
      }).success,
    ).toBe(false);
    expect(
      onboardingPreferenceSchema.safeParse({
        criterion: 'values',
        strength: 'strong_preference',
        value: 'kindness',
        deal_breaker: false,
      }).success,
    ).toBe(false);
  });

  it('requires Dating mode and explicit confirmation twice', () => {
    expect(onboardingModeSchema.safeParse('dating').success).toBe(true);
    expect(
      onboardingConfirmSchema.safeParse({
        purpose: 'discovery',
        session_id: '00000000-0000-4000-8000-000000000001',
        proposal_id: 'bad',
        expected_version: 0,
        expected_answer_revision: 0,
        modes_version: 1,
        modes: ['friends'],
        preferences: [],
      }).success,
    ).toBe(false);
    expect(
      onboardingAnswerSchema.safeParse({
        purpose: 'discovery',
        mode: 'friends',
        revision: 1,
        text: 'I prefer thoughtful letters.',
      }).success,
    ).toBe(true);
  });

  it('requires explicit provider and retention consent', () => {
    expect(
      providerConsentSchema.safeParse({
        purpose: 'discovery',
        provider: 'local',
        receipt_version: 1,
        retention: 'none',
        granted: true,
      }).success,
    ).toBe(true);
    expect(providerConsentSchema.safeParse({ provider: 'local', granted: true }).success).toBe(
      false,
    );
  });
});
