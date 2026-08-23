import { describe, expect, it } from 'vitest';
import {
  onboardingAnswerSchema,
  onboardingConfirmSchema,
  onboardingCreateSchema,
  onboardingExtractSchema,
  onboardingReplaceSchema,
  providerConsentSchema,
} from '../src/onboarding/index.js';

describe('ONB-01 R1 strict purpose/mode/version contracts', () => {
  it('requires explicit purpose and closed mode metadata on every mutation', () => {
    expect(
      onboardingCreateSchema.safeParse({ modes: ['friends'], dating_enabled: false }).success,
    ).toBe(false);
    expect(
      onboardingCreateSchema.safeParse({
        purpose: 'discovery',
        modes: ['friends'],
        dating_enabled: false,
      }).success,
    ).toBe(true);
    expect(
      onboardingCreateSchema.safeParse({
        purpose: 'discovery',
        modes: ['dating'],
        dating_enabled: false,
      }).success,
    ).toBe(false);
    expect(
      onboardingAnswerSchema.safeParse({
        purpose: 'discovery',
        mode: 'friends',
        revision: 0,
        text: 'hello',
      }).success,
    ).toBe(true);
    expect(
      onboardingAnswerSchema.safeParse({
        purpose: 'discovery',
        mode: 'unknown',
        revision: 0,
        text: 'hello',
      }).success,
    ).toBe(false);
  });
  it('binds extraction/confirmation/replacement to session, purpose and versions', () => {
    expect(
      onboardingExtractSchema.safeParse({
        purpose: 'discovery',
        mode: 'friends',
        session_id: '00000000-0000-4000-8000-000000000001',
        consent_id: '00000000-0000-4000-8000-000000000002',
        provider: 'local',
        expected_answer_revision: 1,
        modes_version: 1,
      }).success,
    ).toBe(true);
    expect(
      onboardingConfirmSchema.safeParse({
        purpose: 'discovery',
        session_id: '00000000-0000-4000-8000-000000000001',
        proposal_id: '00000000-0000-4000-8000-000000000002',
        expected_version: 0,
        expected_answer_revision: 1,
        modes_version: 1,
        modes: ['friends'],
        preferences: [],
        confirm_dating: true,
      }).success,
    ).toBe(true);
    expect(
      onboardingReplaceSchema.safeParse({
        purpose: 'profile',
        modes: ['friends'],
        mode: 'friends',
        modes_version: 1,
        expected_version: 0,
        preferences: [],
      }).success,
    ).toBe(true);
  });
  it('requires provider consent version and safe retention vocabulary', () => {
    expect(
      providerConsentSchema.safeParse({
        purpose: 'discovery',
        provider: 'local',
        retention: 'none',
        granted: true,
      }).success,
    ).toBe(false);
    expect(
      providerConsentSchema.safeParse({
        purpose: 'discovery',
        provider: 'local',
        receipt_version: 1,
        retention: 'none',
        granted: true,
      }).success,
    ).toBe(true);
  });
  it('requires every preference to carry a closed mode binding', async () => {
    const { onboardingPreferenceSchema } = await import('../src/onboarding/index.js');
    expect(
      onboardingPreferenceSchema.safeParse({
        mode: 'friends',
        criterion: 'values',
        strength: 'weak_preference',
        value: 'kindness',
        deal_breaker: false,
      }).success,
    ).toBe(true);
    expect(
      onboardingPreferenceSchema.safeParse({
        mode: 'other',
        criterion: 'values',
        strength: 'weak_preference',
        value: 'kindness',
        deal_breaker: false,
      }).success,
    ).toBe(false);
  });
});
