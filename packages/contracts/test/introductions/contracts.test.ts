import { describe, expect, it } from 'vitest';
import {
  introductionCandidateSchema,
  introductionListQuerySchema,
  introductionDecisionRequestSchema,
  rankIntroduction,
  rankIntroductionFromSafeFacts,
} from '@wai/contracts';
describe('MCH-01 contracts and deterministic rules', () => {
  it('rejects public score and unknown explanation fields', () => {
    expect(() =>
      introductionCandidateSchema.parse({
        id: crypto.randomUUID(),
        mode: 'friends',
        reasons: ['SHARED_INTEREST'],
        explanation: 'safe',
        decision: null,
        outcome: null,
        score: 99,
      }),
    ).toThrow();
  });
  it('bounds list queries and keeps cursor signed-shaped', () => {
    expect(introductionListQuerySchema.parse({ mode: 'friends', limit: 10 })).toEqual({
      mode: 'friends',
      limit: 10,
    });
    expect(() => introductionListQuerySchema.parse({ mode: 'friends', limit: 21 })).toThrow();
  });
  it('requires batch binding for a decision', () => {
    expect(() => introductionDecisionRequestSchema.parse({ decision: 'interested' })).toThrow();
  });
  it('fails closed when either hard requirement is unknown or absent', () => {
    const a = [
      {
        criterion: 'language',
        value: 'en',
        strength: 'hard_requirement' as const,
        deal_breaker: false,
        visible: true,
      },
    ];
    const b = [
      {
        criterion: 'language',
        value: 'unknown',
        strength: 'weak_preference' as const,
        deal_breaker: false,
        visible: false,
      },
    ];
    expect(rankIntroduction({ mode: 'friends', actor: a, subject: b }).eligible).toBe(false);
  });
  it('is symmetric for compatible visible facts', () => {
    const a = [
      {
        criterion: 'shared_interests',
        value: 'music',
        strength: 'strong_preference' as const,
        deal_breaker: false,
        visible: true,
      },
    ];
    const b = [
      {
        criterion: 'shared_interests',
        value: 'music',
        strength: 'strong_preference' as const,
        deal_breaker: false,
        visible: true,
      },
    ];
    const one = rankIntroduction({ mode: 'friends', actor: a, subject: b });
    const two = rankIntroduction({ mode: 'friends', actor: b, subject: a });
    expect(two).toEqual(one);
  });
  it('matches requirements to PRF safe facts and fails closed for hidden/unsupported facts', () => {
    const req = [
      {
        criterion: 'language',
        value: 'en',
        strength: 'hard_requirement' as const,
        deal_breaker: false,
        visible: false,
      },
    ];
    expect(
      rankIntroductionFromSafeFacts({
        mode: 'friends',
        actorRequirements: req,
        subjectRequirements: req,
        actorFacts: [],
        subjectFacts: [],
      }).eligible,
    ).toBe(false);
    expect(
      rankIntroductionFromSafeFacts({
        mode: 'friends',
        actorRequirements: req,
        subjectRequirements: req,
        actorFacts: [{ criterion: 'language', value: 'en', visible: true }],
        subjectFacts: [{ criterion: 'language', value: 'en', visible: true }],
      }).eligible,
    ).toBe(true);
    const unsupported = [{ ...req[0]!, criterion: 'unsupported' }];
    expect(
      rankIntroductionFromSafeFacts({
        mode: 'friends',
        actorRequirements: unsupported,
        subjectRequirements: unsupported,
        actorFacts: [{ criterion: 'unsupported', value: 'x', visible: true }],
        subjectFacts: [{ criterion: 'unsupported', value: 'x', visible: true }],
      }).eligible,
    ).toBe(false);
  });
});
