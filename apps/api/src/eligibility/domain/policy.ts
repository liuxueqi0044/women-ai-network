import type { AgeBand, ModeCode, PolicyDocument } from '@wai/contracts';

/**
 * ELG-01 pure policy domain. Inputs are zod-validated PolicyDocuments, so
 * all six mode rules are guaranteed present; the requireRule guard exists
 * to fail closed (never silently relax) if that invariant is ever broken.
 */

/** Fixed dating floor — independent of any policy content. */
export const DATING_HARD_FLOOR = 18;

function requireRule<T>(rules: Partial<Record<ModeCode, T>>, mode: ModeCode, name: string): T {
  const value = rules[mode];
  if (value === undefined) {
    throw new Error(`policy document missing ${name} for mode ${mode}`);
  }
  return value;
}

/**
 * The core formula (task book §5). A missing rule is a policy-document
 * violation — throw, never fall back to a permissive default.
 */
export function effectiveMinimumAge(
  policy: Pick<PolicyDocument, 'minimum_account_age' | 'age_of_majority' | 'mode_rules'>,
  mode: ModeCode,
): number {
  const candidates = [
    policy.minimum_account_age,
    requireRule(
      policy.mode_rules.platform_minimum_age_by_mode,
      mode,
      'platform_minimum_age_by_mode',
    ),
    requireRule(policy.mode_rules.mode_minimum_age, mode, 'mode_minimum_age'),
  ];
  if (mode === 'dating') {
    candidates.push(DATING_HARD_FLOOR, policy.age_of_majority);
  }
  return Math.max(...candidates);
}

/**
 * Age band from the policy's thresholds: below the account minimum →
 * `below_minimum`; at or above the age of majority → `adult`; otherwise
 * `youth`.
 */
export function deriveAgeBand(
  ageYears: number,
  minimumAccountAge: number,
  ageOfMajority: number,
): AgeBand {
  if (ageYears < minimumAccountAge) {
    return 'below_minimum';
  }
  if (ageYears < ageOfMajority) {
    return 'youth';
  }
  return 'adult';
}

/**
 * Per-year cohort key (task book §4.3): `below_minimum`, `youth_<age>`,
 * `adult`. Deterministic and policy-independent for a given band split.
 */
export function deriveCohortKey(
  ageYears: number,
  minimumAccountAge: number,
  ageOfMajority: number,
): string {
  if (ageYears < minimumAccountAge) {
    return 'below_minimum';
  }
  if (ageYears < ageOfMajority) {
    return `youth_${ageYears}`;
  }
  return 'adult';
}
