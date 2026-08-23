import type { PolicyDocument } from '@wai/contracts';
import { canonicalJsonHash, createEligibilityRepositories, type Db } from '@wai/db';

/**
 * Synthetic approved policy for the integration suite. Marked is_synthetic so
 * it is distinguishable from operator-published content; the interval is
 * open-ended from (now - 1 day) so any request in the suite is inside it.
 * The stored content must satisfy the strict policyDocumentSchema — the
 * selector re-validates on every read and fails closed otherwise.
 */

export const SYNTHETIC_POLICY_ID = '11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b';
export const SYNTHETIC_POLICY_REVISION = 1;
export const SYNTHETIC_JURISDICTION = 'US';
export const SYNTHETIC_POLICY_TIMEZONE = 'America/New_York';
export const SYNTHETIC_CA_POLICY_ID = '22f2c8c8-6b8e-4b1a-9f3a-8c9d1e2f3a4b';

const ALL_MODES = ['friends', 'activities', 'professional', 'circles', 'events', 'dating'] as const;

export function syntheticPolicyDocument(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return {
    policy_id: SYNTHETIC_POLICY_ID,
    revision: SYNTHETIC_POLICY_REVISION,
    minimum_account_age: 13,
    age_of_majority: 18,
    digital_consent_age: 16,
    parental_consent_required_below: 16,
    youth_launch_state: 'launched',
    allowed_cohorts: ['youth_13', 'youth_14', 'youth_15', 'youth_16', 'youth_17', 'adult'],
    cross_cohort_contact_policy: 'same_cohort_only',
    mode_rules: {
      mode_enabled: Object.fromEntries(ALL_MODES.map((mode) => [mode, true])) as Record<
        string,
        boolean
      >,
      platform_minimum_age_by_mode: Object.fromEntries(
        ALL_MODES.map((mode) => [mode, mode === 'dating' ? 18 : 13]),
      ) as Record<string, number>,
      mode_minimum_age: Object.fromEntries(ALL_MODES.map((mode) => [mode, 0])) as Record<
        string,
        number
      >,
      required_age_assurance_by_mode: Object.fromEntries(
        ALL_MODES.map((mode) => [mode, 'self_declared']),
      ) as Record<string, 'self_declared'>,
    },
    ...overrides,
  };
}

/** Hash of the decision-relevant rules — the CP5 engine's integrity anchor. */
function syntheticRuleHash(content: PolicyDocument): string {
  return canonicalJsonHash({
    minimum_account_age: content.minimum_account_age,
    age_of_majority: content.age_of_majority,
    digital_consent_age: content.digital_consent_age,
    parental_consent_required_below: content.parental_consent_required_below,
    youth_launch_state: content.youth_launch_state,
    allowed_cohorts: content.allowed_cohorts,
    cross_cohort_contact_policy: content.cross_cohort_contact_policy,
    mode_rules: content.mode_rules,
  });
}

/** Approved synthetic policy with an explicit interval (no overlap guarantee — callers must keep windows disjoint). */
export async function insertApprovedPolicy(
  db: Db,
  input: {
    id: string;
    jurisdictionKey: string;
    revision: number;
    document?: PolicyDocument;
    timezone?: string;
    effectiveFrom: Date;
    effectiveUntil: Date | number;
  },
): Promise<void> {
  const content = input.document ?? syntheticPolicyDocument();
  await createEligibilityRepositories(db).jurisdictionPolicies.insert({
    id: input.id,
    jurisdictionKey: input.jurisdictionKey,
    revision: input.revision,
    status: 'approved',
    content,
    contentHash: canonicalJsonHash(content),
    ruleHash: syntheticRuleHash(content),
    locationPrecisionPolicy: 'country_and_subdivision',
    profilingPolicy: 'derived_facts_only',
    retentionPolicy: 'credential_until_superseded',
    legalBasisRefs: ['synthetic:test'],
    reviewedBy: 'synthetic-test-reviewer',
    reviewedAt: new Date(),
    timezone: input.timezone ?? SYNTHETIC_POLICY_TIMEZONE,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil,
    isSynthetic: true,
    now: new Date(),
  });
}

export async function seedSyntheticPolicy(db: Db): Promise<void> {
  await insertApprovedPolicy(db, {
    id: SYNTHETIC_POLICY_ID,
    jurisdictionKey: SYNTHETIC_JURISDICTION,
    revision: SYNTHETIC_POLICY_REVISION,
    effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
    // Open-ended interval — the repository stores the number Infinity as
    // timestamptz 'infinity'.
    effectiveUntil: Infinity,
  });
}

/**
 * US-CA subdivision policy for the subdivision-override test: observably
 * stricter than the country fallback (parental consent below 18 instead of
 * 16), so a 16-year-old is denied in CA but allowed under the US fallback.
 */
export async function seedCaPolicy(db: Db): Promise<void> {
  await insertApprovedPolicy(db, {
    id: SYNTHETIC_CA_POLICY_ID,
    jurisdictionKey: 'US-CA',
    revision: 1,
    document: syntheticPolicyDocument({
      policy_id: SYNTHETIC_CA_POLICY_ID,
      parental_consent_required_below: 18,
    }),
    effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
    effectiveUntil: Infinity,
  });
}
