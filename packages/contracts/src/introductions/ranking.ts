import type { IntroductionMode, IntroductionReasonCode } from './enums.js';

export const INTRODUCTION_ALGORITHM_VERSION = 'mch-01-deterministic-v1';
export const INTRODUCTION_CONFIG_VERSION = 'mch-01-config-v1';
export const INTRODUCTION_BATCH_LIMIT = 10;
export const INTRODUCTION_BATCH_SCAN_CHUNK = 100;
export const INTRODUCTION_BATCH_SCAN_LIMIT = 1000;
export const INTRODUCTION_REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
export const INTRODUCTION_PASS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type MatchingPreference = {
  criterion: string;
  value: string;
  strength: 'hard_requirement' | 'strong_preference' | 'weak_preference' | 'does_not_matter';
  deal_breaker: boolean;
  visible: boolean;
};
export type RankingInput = {
  mode: IntroductionMode;
  actor: readonly MatchingPreference[];
  subject: readonly MatchingPreference[];
};
export type RankingResult = {
  eligible: boolean;
  score: number;
  reasons: IntroductionReasonCode[];
  visibleFacts: string[];
};
export type MatchingFact = { criterion: string; value: string; visible: boolean };
/** PRF fact-key to the frozen MCH criterion vocabulary. */
export const safeFactCriterion: Record<string, string> = {
  interests: 'shared_interests',
  availability: 'availability',
};

const reasonFor: Record<string, IntroductionReasonCode> = {
  shared_interests: 'SHARED_INTEREST',
  communication_style: 'COMMUNICATION_FIT',
  communication_frequency: 'PACE_ALIGNMENT',
  availability: 'AVAILABILITY_ALIGNMENT',
  language: 'LANGUAGE_ALIGNMENT',
  geography: 'GEOGRAPHY_ALIGNMENT',
  values: 'VALUES_ALIGNMENT',
};
function equalValue(a: string, b: string) {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}
const closedComparators: Record<string, (a: string, b: string) => boolean> = {
  shared_interests: (a, b) => {
    const left = a
      .split(/[,;|]/)
      .map((v) => v.trim().toLocaleLowerCase())
      .filter(Boolean);
    const right = b
      .split(/[,;|]/)
      .map((v) => v.trim().toLocaleLowerCase())
      .filter(Boolean);
    return left.length > 0 && right.some((value) => left.includes(value));
  },
  communication_style: equalValue,
  communication_frequency: equalValue,
  availability: equalValue,
  language: equalValue,
  geography: equalValue,
  values: equalValue,
};
export function hardRequirementsMatch(
  requirements: readonly MatchingPreference[],
  facts: readonly MatchingFact[],
) {
  return requirements
    .filter((req) => req.strength === 'hard_requirement' || req.deal_breaker)
    .every((req) => {
      const comparator = closedComparators[req.criterion];
      return (
        comparator !== undefined &&
        facts.some((fact) => fact.criterion === req.criterion && comparator(fact.value, req.value))
      );
    });
}
/** Pure, symmetric, closed-vocabulary ranking. Hidden values never become reasons. */
export function rankIntroduction(input: RankingInput): RankingResult {
  const reasons = new Set<IntroductionReasonCode>();
  const visibleFacts: string[] = [];
  let score = 0;
  const hardSatisfied = (
    side: readonly MatchingPreference[],
    other: readonly MatchingPreference[],
  ) =>
    side
      .filter((p) => p.strength === 'hard_requirement' || p.deal_breaker)
      .every((p) => {
        const match = other.some(
          (candidate) =>
            candidate.criterion === p.criterion && equalValue(candidate.value, p.value),
        );
        return match;
      });
  if (!hardSatisfied(input.actor, input.subject) || !hardSatisfied(input.subject, input.actor))
    return { eligible: false, score: 0, reasons: [], visibleFacts: [] };
  for (const a of input.actor) {
    const b = input.subject.find(
      (p) => p.criterion === a.criterion && equalValue(p.value, a.value),
    );
    if (
      !b ||
      !a.visible ||
      !b.visible ||
      a.strength === 'does_not_matter' ||
      b.strength === 'does_not_matter'
    )
      continue;
    const reason = reasonFor[a.criterion];
    if (!reason) continue;
    reasons.add(reason);
    score += a.strength === 'strong_preference' || b.strength === 'strong_preference' ? 3 : 1;
    visibleFacts.push(a.criterion);
  }
  return {
    eligible: reasons.size > 0,
    score,
    reasons: [...reasons].sort(),
    visibleFacts: [...new Set(visibleFacts)].sort(),
  };
}

/** Match requirements to the other member's PRF-owned safe facts. Missing
 * facts are unknown and therefore fail hard requirements. */
export function rankIntroductionFromSafeFacts(input: {
  mode: IntroductionMode;
  actorRequirements: readonly MatchingPreference[];
  subjectRequirements: readonly MatchingPreference[];
  actorFacts: readonly MatchingFact[];
  subjectFacts: readonly MatchingFact[];
}): RankingResult {
  const reasons = new Set<IntroductionReasonCode>();
  const visibleFacts = new Set<string>();
  const scoreSide = (
    requirements: readonly MatchingPreference[],
    facts: readonly MatchingFact[],
  ) => {
    let score = 0;
    for (const req of requirements) {
      if (req.strength === 'does_not_matter') continue;
      const comparator = closedComparators[req.criterion];
      if (!comparator) {
        if (req.strength === 'hard_requirement' || req.deal_breaker) return null;
        continue;
      }
      const fact = facts.find(
        (candidate) =>
          candidate.criterion === req.criterion && comparator(candidate.value, req.value),
      );
      if (!fact) {
        if (req.strength === 'hard_requirement' || req.deal_breaker) return null;
        continue;
      }
      const reason = reasonFor[req.criterion];
      if (reason && req.visible && fact.visible) {
        reasons.add(reason);
        visibleFacts.add(req.criterion);
      } else {
        // A matched private requirement may affect eligibility/score but can
        // only render as a closed generic explanation.
        reasons.add('PREFERENCES_ALIGN');
      }
      score += req.strength === 'strong_preference' ? 3 : 1;
    }
    return score;
  };
  const actorScore = scoreSide(input.actorRequirements, input.subjectFacts);
  const subjectScore = scoreSide(input.subjectRequirements, input.actorFacts);
  if (actorScore === null || subjectScore === null || reasons.size === 0)
    return { eligible: false, score: 0, reasons: [], visibleFacts: [] };
  return {
    eligible: true,
    score: actorScore + subjectScore,
    reasons: [...reasons].sort(),
    visibleFacts: [...visibleFacts].sort(),
  };
}
