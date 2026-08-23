import {
  OPEN_ENDED,
  policyDocumentSchema,
  type JurisdictionPolicySelection,
  type JurisdictionPolicySelector,
} from '@wai/contracts';
import type {
  JurisdictionDeclarationRepository,
  JurisdictionPolicyRepository,
  JurisdictionPolicyRow,
} from '@wai/db';
import { canonicalJsonHash } from '@wai/db';

/**
 * DB-backed policy selection (task book §7). The subdivision policy active
 * at the effective instant wins; when the subdivision has no active approved
 * policy the country policy is the fallback. Stored `content` is re-validated
 * with the strict schema on every read — an invalid document throws (fail
 * closed) instead of leaking half-parsed rules into a decision.
 */
export class PgJurisdictionPolicySelector implements JurisdictionPolicySelector {
  constructor(
    private readonly declarations: Pick<JurisdictionDeclarationRepository, 'current'> &
      Partial<Pick<JurisdictionDeclarationRepository, 'at'>>,
    private readonly policies: Pick<JurisdictionPolicyRepository, 'findActive'>,
  ) {}

  async select(
    accountId: string,
    effectiveAt: string,
  ): Promise<JurisdictionPolicySelection | null> {
    const at = new Date(effectiveAt);
    const declaration = this.declarations.at
      ? await this.declarations.at(accountId, at)
      : await this.declarations.current(accountId);
    if (declaration === null) {
      return null;
    }
    if (declaration.reviewState !== 'accepted') return null;
    if (declaration.subdivisionCode !== null) {
      const subdivisionKey = `${declaration.countryCode}-${declaration.subdivisionCode}`;
      const subdivision = await this.policies.findActive(subdivisionKey, at);
      if (subdivision !== null) {
        return this.toSelection(subdivision, subdivisionKey);
      }
    }
    const country = await this.policies.findActive(declaration.countryCode, at);
    if (country === null) {
      return null;
    }
    return this.toSelection(country, declaration.countryCode);
  }

  private toSelection(
    row: JurisdictionPolicyRow,
    jurisdictionKey: string,
  ): JurisdictionPolicySelection {
    const parsed = policyDocumentSchema.safeParse(row.content);
    if (!parsed.success) {
      throw new Error(
        `jurisdiction policy ${row.id} content failed validation: ${parsed.error.message}`,
      );
    }
    if (parsed.data.policy_id !== row.id || parsed.data.revision !== row.revision) {
      throw new Error(`jurisdiction policy ${row.id} content identity does not match database row`);
    }
    const computedContentHash = canonicalJsonHash(parsed.data);
    const computedRuleHash = canonicalJsonHash({
      minimum_account_age: parsed.data.minimum_account_age,
      age_of_majority: parsed.data.age_of_majority,
      digital_consent_age: parsed.data.digital_consent_age,
      parental_consent_required_below: parsed.data.parental_consent_required_below,
      youth_launch_state: parsed.data.youth_launch_state,
      allowed_cohorts: parsed.data.allowed_cohorts,
      cross_cohort_contact_policy: parsed.data.cross_cohort_contact_policy,
      mode_rules: parsed.data.mode_rules,
    });
    if (computedContentHash !== row.contentHash || computedRuleHash !== row.ruleHash) {
      throw new Error(`jurisdiction policy ${row.id} hash integrity check failed`);
    }
    return {
      policy_id: row.id,
      jurisdiction_key: jurisdictionKey,
      revision: row.revision,
      timezone: row.timezone,
      effective_from: row.effectiveFrom.toISOString(),
      effective_until:
        typeof row.effectiveUntil === 'number' ? OPEN_ENDED : row.effectiveUntil.toISOString(),
      // Immutable per policy row — the decision snapshot's policy_hash anchor.
      content_hash: row.contentHash,
      document: parsed.data,
    };
  }
}
